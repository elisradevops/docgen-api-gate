import datetime
import re
from minio import Minio
import sys
import os
import requests
import base64
from datetime import datetime
from PIL import Image
import uuid


class AttachmentService:
    def __init__(self, bucket_name, minio_end_point, minio_access_key, minio_secret_key, url, ext, project_name, token, is_base64=False, base64_chunks=None):
        self.bucket_name = bucket_name
        self.minio_end_point = minio_end_point
        self.minio_access_key = minio_access_key
        self.minio_secret_key = minio_secret_key
        self.url = url # can be http://... or data:...
        self.ext = ext
        self.project_name = project_name
        self.token = token
        self.authorization = str(base64.b64encode(bytes(':' + self.token, 'ascii')), 'ascii')
        self.headers = {
          'Authorization': 'Basic '+self.authorization
        }
        self.image_extensions = [".jpg", ".jpeg", ".png", ".ico", ".im", ".pcx", ".tga", ".tiff"]
        self.is_base64 = is_base64
        self.base64_chunks = base64_chunks

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
            print(f"Error processing base64 chunks: {str(e)}")
            return False

    async def process_attachment(self):
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
                        return self._return_bad_attachment()

                    base64_data = match.group(2)
                    with open(file_name, 'wb') as f:
                        f.write(base64.b64decode(base64_data))
                else:
                    # Normal URL -> Download from Azure DevOps or wherever
                    azure_response = requests.get(self.url + "?download=true", headers=self.headers)
                    with open(file_name, 'wb') as f:
                        f.write(azure_response.content)

            # 3) Check file size
            if os.stat(file_name).st_size == 0:
                # If empty, remove file & return "bad" path
                os.remove(file_name)
                return self._return_bad_attachment()

            # 4) Upload to Minio
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

            value = {}

            # 5) If it's an image extension, create & upload a thumbnail too
            if self.ext.lower() in self.image_extensions:
                image = Image.open(file_name)
                thumbnail_name = file_base_name + "-thumbnail" + self.ext
                thumbnail_file_path = f"{self.project_name}/{time_now}/{thumbnail_name}"
                thumbnail_image = image.resize((256, 256))
                thumbnail_image.save(thumbnail_name)

                client.fput_object(
                    self.bucket_name, thumbnail_file_path, thumbnail_name,
                )

                thumbnail_path = f"http://{self.minio_end_point}/{self.bucket_name}/{thumbnail_file_path}"
                os.remove(thumbnail_name)

                value = {
                    "attachmentPath": full_download_path,
                    "fileName": file_name,
                    "thumbnailPath": thumbnail_path,
                    "thumbnailName": thumbnail_name
                }
            else:
                value = {
                    "attachmentPath": full_download_path,
                    "fileName": file_name
                }

            # Remove local file after uploading
            os.remove(file_name)

        except Exception as e:
            print(f"Error in process_attachment: {str(e)}")
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

