import asyncio
import base64
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
    def create_service(self, token="bearer:abc.def.ghi"):
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


if __name__ == "__main__":
    unittest.main()
