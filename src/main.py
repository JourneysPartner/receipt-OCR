"""Cloud Run Job エントリポイント"""

import sys

from src.ai.factory import create_ai_extractor
from src.config import load_config
from src.drive.client import DriveClient
from src.logging.logger import setup_logger
from src.ocr.factory import create_ocr_engine
from src.processing.manager import ProcessingManager
from src.rules.corrections import RuleCorrector
from src.sheets.client import MasterSheetClient


def main() -> int:
    config = load_config()
    logger = setup_logger(level=config.log_level)
    logger.info("=== レシート OCR ジョブ開始 ===", extra={"step": "job_start"})

    if not config.master.spreadsheet_id:
        logger.error("MASTER_SPREADSHEET_ID 未設定", extra={"step": "validation"})
        return 1
    if not config.template.individual_template_id:
        logger.error("INDIVIDUAL_TEMPLATE_SPREADSHEET_ID 未設定", extra={"step": "validation"})
        return 1
    if not config.template.corporate_template_id:
        logger.error("CORPORATE_TEMPLATE_SPREADSHEET_ID 未設定", extra={"step": "validation"})
        return 1
    if not config.template.output_folder_id:
        logger.error("CASHBOOK_OUTPUT_FOLDER_ID 未設定", extra={"step": "validation"})
        return 1

    try:
        cp = config.google_credentials_path
        manager = ProcessingManager(
            config=config,
            drive=DriveClient(config.drive, cp),
            master=MasterSheetClient(config.master, cp),
            ocr=create_ocr_engine(config.ocr),
            ai=create_ai_extractor(config.ai, api_key=config.gemini_api_key),
            corrector=RuleCorrector(confidence_threshold=config.ai.confidence_threshold),
        )
        summary = manager.run()
        logger.info(f"=== ジョブ完了: {summary} ===", extra={"step": "job_complete"})
        return 0
    except Exception as e:
        logger.error(f"ジョブ異常終了: {e}", extra={"step": "job_fatal"}, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
