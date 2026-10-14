import asyncio
import base64
import contextlib
import io
import os
import sys
import types
import unittest
from unittest.mock import Mock, patch


minio_module = types.ModuleType("minio")
minio_module.Minio = Mock
sys.modules.setdefault("minio", minio_module)

requests_module = types.ModuleType("requests")
requests_module.Session = Mock
requests_adapters_module = types.ModuleType("requests.adapters")
requests_adapters_module.HTTPAdapter = Mock
requests_module.adapters = requests_adapters_module
sys.modules.setdefault("requests", requests_module)
sys.modules.setdefault("requests.adapters", requests_adapters_module)

urllib3_module = types.ModuleType("urllib3")
urllib3_util_module = types.ModuleType("urllib3.util")
urllib3_retry_module = types.ModuleType("urllib3.util.retry")
urllib3_retry_module.Retry = Mock
urllib3_util_module.retry = urllib3_retry_module
urllib3_module.util = urllib3_util_module
sys.modules.setdefault("urllib3", urllib3_module)
sys.modules.setdefault("urllib3.util", urllib3_util_module)
sys.modules.setdefault("urllib3.util.retry", urllib3_retry_module)

pil_module = types.ModuleType("PIL")
image_module = types.ModuleType("PIL.Image")
pil_module.Image = image_module
sys.modules.setdefault("PIL", pil_module)
sys.modules.setdefault("PIL.Image", image_module)

from attachment_service import AttachmentService


class AttachmentServiceAuthTests(unittest.TestCase):
    def create_service(self, token):
        return AttachmentService(
            "attachments",
            "minio:9000",
            "access",
            "secret",
            "https://dev.azure.com/org/project/_apis/wit/attachments/1/file.png",
            ".png",
            "Project",
            token,
        )

    def test_pat_token_uses_basic_auth(self):
        service = self.create_service("pat-token")

        expected = base64.b64encode(b":pat-token").decode("ascii")
        self.assertEqual(service.headers, {"Authorization": f"Basic {expected}"})

    def test_bearer_colon_token_uses_bearer_auth(self):
        service = self.create_service("bearer:abc.def.ghi")

        self.assertEqual(service.headers, {"Authorization": "Bearer abc.def.ghi"})

    def test_bearer_space_token_uses_bearer_auth(self):
        service = self.create_service("Bearer abc.def.ghi")

        self.assertEqual(service.headers, {"Authorization": "Bearer abc.def.ghi"})

    def test_raw_jwt_token_uses_bearer_auth(self):
        service = self.create_service("abc.def.ghi")

        self.assertEqual(service.headers, {"Authorization": "Bearer abc.def.ghi"})


class AttachmentServiceDownloadTests(unittest.TestCase):
    def create_service(self, token="bearer:abc.def.ghi", ext=".png"):
        return AttachmentService(
            "attachments",
            "minio:9000",
            "access",
            "secret",
            "https://dev.azure.com/org/project/_apis/wit/attachments/1/file.png",
            ext,
            "Project",
            token,
        )

    def test_failed_azure_response_returns_bad_attachment_without_minio_upload(self):
        service = self.create_service()
        response = Mock()
        response.raise_for_status.side_effect = Exception("401 Client Error")
        response.content = b"not an image"
        session = Mock()
        session.get.return_value = response

        with patch.object(AttachmentService, "_get_session", return_value=session), patch(
            "attachment_service.Minio"
        ) as minio_mock:
            result = asyncio.run(service.process_attachment())

        self.assertEqual(result["fileName"], "bad-attachment.png")
        self.assertEqual(result["attachmentPath"], "http://minio:9000/attachments/bad-attachment.png")
        minio_mock.assert_not_called()

    def test_successful_image_download_uses_bearer_header_and_checks_status(self):
        service = self.create_service()
        response = Mock()
        response.content = b"image-bytes"
        session = Mock()
        session.get.return_value = response
        minio_client = Mock()
        image = Mock()

        def save_thumbnail(path):
            with open(path, "wb") as thumbnail:
                thumbnail.write(b"thumbnail")

        image.resize.return_value.save.side_effect = save_thumbnail

        with patch.object(AttachmentService, "_get_session", return_value=session), patch(
            "attachment_service.Minio", return_value=minio_client
        ), patch("attachment_service.Image.open", return_value=image):
            result = asyncio.run(service.process_attachment())

        session.get.assert_called_once_with(
            "https://dev.azure.com/org/project/_apis/wit/attachments/1/file.png?download=true",
            headers={"Authorization": "Bearer abc.def.ghi"},
        )
        response.raise_for_status.assert_called_once()
        self.assertTrue(result["fileName"].endswith(".png"))
        self.assertTrue(result["thumbnailName"].endswith("-thumbnail.png"))
        self.assertEqual(minio_client.fput_object.call_count, 2)
        self.assertFalse(os.path.exists(result["fileName"]))
        self.assertFalse(os.path.exists(result["thumbnailName"]))

    def download_image(self, service, image):
        response = Mock()
        response.content = b"image-bytes"
        session = Mock()
        session.get.return_value = response
        minio_client = Mock()
        with patch.object(AttachmentService, "_get_session", return_value=session), patch(
            "attachment_service.Minio", return_value=minio_client
        ), patch("attachment_service.Image.open", return_value=image):
            result = asyncio.run(service.process_attachment())
        return result, minio_client

    def test_rgba_image_with_jpg_extension_gets_flattened_jpeg_thumbnail(self):
        service = self.create_service(ext=".jpg")
        thumbnail = Mock(mode="RGBA", info={}, size=(256, 256))
        thumbnail.convert.return_value = thumbnail
        image = Mock()
        image.resize.return_value = thumbnail
        flattened = Mock()

        def save_thumbnail(path):
            with open(path, "wb") as handle:
                handle.write(b"thumbnail")

        flattened.save.side_effect = save_thumbnail

        with patch("attachment_service.Image.new", create=True, return_value=flattened) as image_new:
            result, minio_client = self.download_image(service, image)

        image_new.assert_called_once_with("RGB", (256, 256), (255, 255, 255))
        flattened.paste.assert_called_once_with(thumbnail, mask=thumbnail.getchannel.return_value)
        thumbnail.getchannel.assert_called_once_with("A")
        flattened.save.assert_called_once()
        self.assertTrue(result["fileName"].endswith(".jpg"))
        self.assertNotEqual(result["fileName"], "bad-attachment.png")
        self.assertTrue(result["thumbnailName"].endswith("-thumbnail.jpg"))
        self.assertEqual(minio_client.fput_object.call_count, 2)
        self.assertFalse(os.path.exists(result["thumbnailName"]))

    def test_thumbnail_failure_keeps_the_uploaded_attachment(self):
        service = self.create_service()
        image = Mock()
        image.resize.return_value.save.side_effect = ValueError("cannot write thumbnail")

        result, minio_client = self.download_image(service, image)

        self.assertNotEqual(result["fileName"], "bad-attachment.png")
        self.assertTrue(result["fileName"].endswith(".png"))
        self.assertTrue(result["attachmentPath"].startswith("http://minio:9000/attachments/Project/"))
        self.assertNotIn("thumbnailName", result)
        self.assertNotIn("thumbnailPath", result)
        self.assertEqual(minio_client.fput_object.call_count, 1)

    def run_failing_download(self, service, status, content_type, message):
        response = Mock()
        response.status_code = status
        response.headers = {"Content-Type": content_type, "Retry-After": "30"}
        response.raise_for_status.side_effect = Exception(message)
        session = Mock()
        session.get.return_value = response
        output = io.StringIO()
        with patch.object(AttachmentService, "_get_session", return_value=session), contextlib.redirect_stdout(output):
            result = asyncio.run(service.process_attachment())
        return result, output.getvalue()

    def test_failed_download_logs_stage_status_and_url(self):
        service = self.create_service()

        result, log = self.run_failing_download(
            service, 405, "text/html", "405 Client Error: Method Not Allowed for url: https://x/_apis/wit/attachments?download=true"
        )

        self.assertEqual(result["fileName"], "bad-attachment.png")
        self.assertIn("[attachment] attachment_failed ", log)
        self.assertIn('"stage": "download"', log)
        self.assertIn('"http_status": 405', log)
        self.assertIn('"content_type": "text/html"', log)
        self.assertIn('"retry_after": "30"', log)
        self.assertIn("Method Not Allowed", log)
        self.assertIn("https://dev.azure.com/org/project/_apis/wit/attachments/1/file.png", log)
        self.assertEqual(log.count("\n"), 1)  # one greppable line

    def test_failure_log_never_contains_the_token_or_secret_query_values(self):
        service = AttachmentService(
            "attachments", "minio:9000", "access", "secret",
            "https://user:pw@dev.azure.com/org/_apis/wit/attachments/1/file.png?fileName=a.png&sig=SUPERSECRET",
            ".png", "Project", "bearer:abc.def.ghi",
        )

        _, log = self.run_failing_download(service, 401, "text/html", "401 Client Error")

        for secret in ("abc.def.ghi", "SUPERSECRET", "user:pw", "pw@", "Authorization", "access", "secret"):
            self.assertNotIn(secret, log)
        self.assertIn("fileName=a.png", log)
        self.assertIn("sig=%2A%2A%2A", log)

    def test_blob_url_is_rejected_without_a_request(self):
        service = AttachmentService(
            "attachments", "minio:9000", "access", "secret",
            "blob:https://ado.example/6f1c1c1e-0000-0000-0000-000000000000", ".png", "Project", "pat",
        )
        session = Mock()
        output = io.StringIO()
        with patch.object(AttachmentService, "_get_session", return_value=session), contextlib.redirect_stdout(output):
            result = asyncio.run(service.process_attachment())

        self.assertEqual(result["fileName"], "bad-attachment.png")
        session.get.assert_not_called()
        self.assertIn('"stage": "validate"', output.getvalue())
        self.assertIn("unsupported URL scheme 'blob'", output.getvalue())

    def test_empty_download_logs_the_reason(self):
        service = self.create_service()
        response = Mock(status_code=200, headers={"Content-Type": "image/png"}, content=b"")
        session = Mock()
        session.get.return_value = response
        output = io.StringIO()
        with patch.object(AttachmentService, "_get_session", return_value=session), contextlib.redirect_stdout(output):
            result = asyncio.run(service.process_attachment())

        self.assertEqual(result["fileName"], "bad-attachment.png")
        self.assertIn('"stage": "empty-check"', output.getvalue())
        self.assertIn("downloaded file is empty", output.getvalue())

    def test_file_that_is_not_an_image_still_returns_bad_attachment(self):
        # The failure path leaves its downloaded temp file behind; remove what this test creates.
        files_before = set(os.listdir("."))
        self.addCleanup(
            lambda: [os.remove(name) for name in set(os.listdir(".")) - files_before if os.path.isfile(name)]
        )
        service = self.create_service()
        response = Mock()
        response.content = b"<html>sign in</html>"
        session = Mock()
        session.get.return_value = response

        with patch.object(AttachmentService, "_get_session", return_value=session), patch(
            "attachment_service.Minio", return_value=Mock()
        ), patch("attachment_service.Image.open", side_effect=OSError("cannot identify image file")):
            result = asyncio.run(service.process_attachment())

        self.assertEqual(result["fileName"], "bad-attachment.png")


if __name__ == "__main__":
    unittest.main()
