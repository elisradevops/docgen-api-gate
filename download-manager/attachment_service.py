import datetime
import re
from minio import Minio
import sys
import os
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import base64
import json
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from datetime import datetime
from PIL import Image
import uuid


class AttachmentService:
    # Connection pooling similar to tfs.ts approach
    _session = None
    
    @classmethod
    def _get_session(cls):
        """Get or create a requests session with connection pooling and SSL configuration"""
        if cls._session is None:
            cls._session = requests.Session()
            
            # Configure retry strategy
            retry_strategy = Retry(
                total=3,
                backoff_factor=1,
                status_forcelist=[429, 500, 502, 503, 504],
            )
            
            # Configure HTTP adapter with connection pooling
            adapter = HTTPAdapter(
                pool_connections=10,
                pool_maxsize=50,
                max_retries=retry_strategy,
                pool_block=False
            )
            
            cls._session.mount("http://", adapter)
            cls._session.mount("https://", adapter)
            
            # Disable SSL verification by default for corporate environments
            cls._session.verify = False
            print("DEBUG: SSL verification DISABLED by default")
        
        return cls._session
    def __init__(self, bucket_name, minio_end_point, minio_access_key, minio_secret_key, url, ext, project_name, token, is_base64=False, base64_chunks=None):
        self.bucket_name = bucket_name
        self.minio_end_point = minio_end_point
        self.minio_access_key = minio_access_key
        self.minio_secret_key = minio_secret_key
        self.url = url # can be http://... or data:...
        self.ext = ext
        self.project_name = project_name
        self.token = token
        self.headers = self._build_auth_headers(token)
        self.image_extensions = [".jpg", ".jpeg", ".png", ".ico", ".im", ".pcx", ".tga", ".tiff"]
        self.jpeg_extensions = [".jpg", ".jpeg"]
        self.is_base64 = is_base64
        self.base64_chunks = base64_chunks

    @staticmethod
    def _flatten_for_jpeg(image):
        """JPEG has no alpha channel. Pillow picks the save format from the extension, so a PNG
        saved under a .jpg name (RGBA) fails with 'cannot write mode RGBA as JPEG'. Transparent
        images are composited onto white; any other mode is converted to RGB."""
        if image.mode in ("RGB", "L"):
            return image
        has_alpha = image.mode in ("RGBA", "LA", "PA", "La", "RGBa") or (
            image.mode == "P" and "transparency" in image.info
        )
        if not has_alpha:
            return image.convert("RGB")
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background

    def _build_auth_headers(self, token):
        token = str(token or '').strip()
        lower_token = token.lower()
        if lower_token.startswith('bearer:'):
            return {
                'Authorization': 'Bearer ' + token.split(':', 1)[1].strip()
            }
        if lower_token.startswith('bearer '):
            return {
                'Authorization': 'Bearer ' + token.split(' ', 1)[1].strip()
            }
        if re.match(r'^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$', token):
            return {
                'Authorization': 'Bearer ' + token
            }
        authorization = str(base64.b64encode(bytes(':' + token, 'ascii')), 'ascii')
        return {
          'Authorization': 'Basic ' + authorization
        }

    _SENSITIVE_QUERY_KEY = re.compile(r"sig|token|key|secret|pat|password|auth", re.IGNORECASE)

    @classmethod
    def _safe_url(cls, url):
        """The request URL for logs: no credentials in the host part, no secret-looking query values, bounded."""
        try:
            parts = urlsplit(url)
            host = parts.hostname or ""
            netloc = host + (":" + str(parts.port) if parts.port else "")
            query = urlencode(
                [(k, "***" if cls._SENSITIVE_QUERY_KEY.search(k) else v) for k, v in parse_qsl(parts.query)]
            )
            return urlunsplit((parts.scheme, netloc, parts.path, query, ""))[:400]
        except Exception:
            return "<unparseable url>"

    @staticmethod
    def _response_info(response):
        """Status, content type and Retry-After of an HTTP response, when it has them (never the body or headers wholesale)."""
        info = {}
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            info["http_status"] = status
        headers = getattr(response, "headers", None)
        if headers is not None:
            try:
                content_type = headers.get("Content-Type")
                retry_after = headers.get("Retry-After")
            except Exception:
                content_type = retry_after = None
            if isinstance(content_type, str):
                info["content_type"] = content_type
            if isinstance(retry_after, str):
                info["retry_after"] = retry_after
        return info

    def _log(self, event, **fields):
        """One greppable line: '[attachment] <event> {json}'. Flushed at once - stdout is block-buffered in a
        container, so an unflushed line can be delayed or lost. Never pass the token or request headers."""
        if self.is_base64 and self.base64_chunks:
            source = "base64-chunks"
        elif str(self.url).startswith("data:"):
            source = "data-url"
        else:
            source = "url"
        context = {"source": source, "ext": self.ext, "project": self.project_name}
        if source == "url":
            context["url"] = self._safe_url(self.url)
        context.update(fields)
        print("[attachment] " + event + " " + json.dumps({k: v for k, v in context.items() if v is not None}, default=str), flush=True)

    @staticmethod
    def _short(error):
        return str(error)[:300]

    def _process_base64_chunks(self, file_name):
        """Reassemble and save base64 chunks to file"""
        try:
            # Combine all chunks
            complete_base64 = ''.join(self.base64_chunks)
            
            # Decode and write to file
            with open(file_name, 'wb') as f:
                f.write(base64.b64decode(complete_base64))
            return True
        except Exception as e:
            self._log("attachment_failed", stage="decode", error_type=type(e).__name__,
                      error=self._short(e), chunks=len(self.base64_chunks or []))
            return False

    async def process_attachment(self):
        started = time.monotonic()
        stage = "init"
        http_info = {}
        try:
            # 1) Generate a unique file name
            file_base_name = str(uuid.uuid4())  # random UUID
            file_name = file_base_name + self.ext

            # 2) Process either base64 chunks or URL
            if self.is_base64 and self.base64_chunks:
                if not self._process_base64_chunks(file_name):
                    return self._return_bad_attachment()
            else:
                # Handle URL download as before
                if self.url.startswith("data:"):
                    # Parse out base64
                    # e.g. data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...
                    match = re.match(r'^data:(.*?);base64,(.*)$', self.url)
                    if not match:
                        # Not properly formed data URL -> treat as invalid
                        self._log("attachment_failed", stage="decode", error="malformed data URL")
                        return self._return_bad_attachment()

                    stage = "decode"
                    base64_data = match.group(2)
                    with open(file_name, 'wb') as f:
                        f.write(base64.b64decode(base64_data))
                else:
                    # Normal URL -> Download from Azure DevOps or wherever using session
                    stage = "download"
                    session = self._get_session()
                    azure_response = session.get(
                        self.url + "?download=true",
                        headers=self.headers
                    )
                    http_info = self._response_info(azure_response)
                    azure_response.raise_for_status()
                    stage = "write"
                    with open(file_name, 'wb') as f:
                        f.write(azure_response.content)

            # 3) Check file size
            stage = "empty-check"
            if os.stat(file_name).st_size == 0:
                # If empty, remove file & return "bad" path
                os.remove(file_name)
                self._log("attachment_failed", stage=stage, error="downloaded file is empty", **http_info)
                return self._return_bad_attachment()

            # 4) Upload to Minio
            stage = "minio-upload"
            client = Minio(
                self.minio_end_point,
                access_key=self.minio_access_key,
                secret_key=self.minio_secret_key,
                secure=False,
            )

            time_now = datetime.now().strftime("%Y-%m-%d")
            file_bucket_path = f"{self.project_name}/{time_now}/{file_name}"
            full_download_path = f"http://{self.minio_end_point}/{self.bucket_name}/{file_bucket_path}"

            client.fput_object(
                self.bucket_name, file_bucket_path, file_name,
            )

            value = {
                "attachmentPath": full_download_path,
                "fileName": file_name
            }

            # 5) If it's an image extension, create & upload a thumbnail too.
            # A file that cannot be opened as an image is still a bad attachment. Once it opens,
            # the thumbnail is optional: the original is already uploaded, so a thumbnail failure
            # must not replace it with the placeholder.
            if self.ext.lower() in self.image_extensions:
                stage = "thumbnail-open"
                image = Image.open(file_name)
                thumbnail_name = file_base_name + "-thumbnail" + self.ext
                thumbnail_file_path = f"{self.project_name}/{time_now}/{thumbnail_name}"
                try:
                    thumbnail_image = image.resize((256, 256))
                    if self.ext.lower() in self.jpeg_extensions:
                        thumbnail_image = self._flatten_for_jpeg(thumbnail_image)
                    thumbnail_image.save(thumbnail_name)

                    client.fput_object(
                        self.bucket_name, thumbnail_file_path, thumbnail_name,
                    )

                    value["thumbnailPath"] = f"http://{self.minio_end_point}/{self.bucket_name}/{thumbnail_file_path}"
                    value["thumbnailName"] = thumbnail_name
                except Exception as e:
                    self._log("thumbnail_skipped", file=file_name, error_type=type(e).__name__,
                              error=self._short(e), image_mode=getattr(image, "mode", None),
                              elapsed_ms=int((time.monotonic() - started) * 1000))
                finally:
                    if os.path.exists(thumbnail_name):
                        os.remove(thumbnail_name)

            # Remove local file after uploading
            os.remove(file_name)

        except Exception as e:
            # A failed request carries its own response (HTTPError); a retry-exhausted one does not.
            failed_info = http_info or self._response_info(getattr(e, "response", None))
            self._log("attachment_failed", stage=stage, error_type=type(e).__name__, error=self._short(e),
                      elapsed_ms=int((time.monotonic() - started) * 1000), **failed_info)
            return self._return_bad_attachment()

        sys.stdout.flush()
        return value

    def _return_bad_attachment(self):
        full_download_path = f"http://{self.minio_end_point}/attachments/bad-attachment.png"
        file_name = "bad-attachment.png"
        return {
            "attachmentPath": full_download_path,
            "fileName": file_name
        }
