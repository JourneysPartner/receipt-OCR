"""Google Cloud Vision API による OCR"""

from google.cloud import vision

from src.config import OcrConfig
from src.logging.logger import setup_logger
from src.models import DriveFile, OcrResult
from src.ocr.base import OcrEngine

logger = setup_logger()


class VisionOcrEngine(OcrEngine):
    def __init__(self, config: OcrConfig):
        self._config = config
        self._client = vision.ImageAnnotatorClient()

    def extract_text(self, file: DriveFile) -> OcrResult:
        try:
            if file.mime_type == "application/pdf":
                return self._from_pdf(file)
            return self._from_image(file)
        except Exception as e:
            logger.error(
                f"OCR失敗: {file.file_name}: {e}", extra={"step": "ocr", "file_id": file.file_id}
            )
            return OcrResult(raw_text="", engine="vision", confidence=0.0, error=str(e))

    def _from_image(self, file: DriveFile) -> OcrResult:
        image = vision.Image(content=file.content)
        resp = self._client.text_detection(image=image)
        if resp.error.message:
            return OcrResult(raw_text="", engine="vision", confidence=0.0, error=resp.error.message)
        anns = resp.text_annotations
        if not anns:
            return OcrResult(raw_text="", engine="vision", confidence=0.0)
        conf = self._page_confidence(resp)
        logger.info(
            f"画像OCR: {file.file_name} ({len(anns[0].description)} chars)",
            extra={"step": "ocr", "file_id": file.file_id},
        )
        return OcrResult(raw_text=anns[0].description, engine="vision", confidence=conf)

    def _from_pdf(self, file: DriveFile) -> OcrResult:
        ic = vision.InputConfig(content=file.content, mime_type="application/pdf")
        feat = vision.Feature(type_=vision.Feature.Type.DOCUMENT_TEXT_DETECTION)
        req = vision.AnnotateFileRequest(
            input_config=ic,
            features=[feat],
            pages=list(range(1, self._config.max_pdf_pages + 1)),
        )
        resp = self._client.batch_annotate_files(requests=[req])
        texts, total_conf, pages = [], 0.0, 0
        for fr in resp.responses:
            for pr in fr.responses:
                if pr.error.message:
                    continue
                ft = pr.full_text_annotation
                if ft and ft.text:
                    texts.append(ft.text)
                    for p in ft.pages:
                        if p.confidence:
                            total_conf += p.confidence
                            pages += 1
        combined = "\n".join(texts)
        avg = total_conf / pages if pages else 0.0
        logger.info(
            f"PDF OCR: {file.file_name} ({pages} pages)",
            extra={"step": "ocr", "file_id": file.file_id},
        )
        return OcrResult(
            raw_text=combined, engine="vision", confidence=avg, page_count=max(pages, 1)
        )

    @staticmethod
    def _page_confidence(resp) -> float:
        try:
            pages = resp.full_text_annotation.pages
            confs = [p.confidence for p in pages if p.confidence]
            return sum(confs) / len(confs) if confs else 0.5
        except AttributeError:
            return 0.5


class VisionDocumentOcrEngine(VisionOcrEngine):
    """Vision API の DOCUMENT_TEXT_DETECTION を使う強化版。
    手書き文字に対して通常の text_detection より読み取りが強いケースがある。
    フォールバック OCR の候補として使う。
    """

    def _from_image(self, file: DriveFile) -> OcrResult:
        image = vision.Image(content=file.content)
        resp = self._client.document_text_detection(image=image)
        if resp.error.message:
            return OcrResult(
                raw_text="",
                engine="vision_document",
                confidence=0.0,
                error=resp.error.message,
            )
        ft = resp.full_text_annotation
        text = ft.text if ft and ft.text else ""
        if not text:
            anns = resp.text_annotations
            if anns:
                text = anns[0].description
        if not text:
            return OcrResult(raw_text="", engine="vision_document", confidence=0.0)
        conf = self._page_confidence(resp)
        logger.info(
            f"画像OCR(document): {file.file_name} ({len(text)} chars)",
            extra={"step": "ocr", "file_id": file.file_id},
        )
        return OcrResult(raw_text=text, engine="vision_document", confidence=conf)

    def extract_text(self, file: DriveFile) -> OcrResult:
        # PDF は親クラスと同じく DOCUMENT_TEXT_DETECTION を使うので
        # 親実装をそのまま流用する。engine 名だけ差し替える。
        result = super().extract_text(file)
        if not result.error:
            result.engine = "vision_document"
        return result
