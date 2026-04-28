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
    try:
        config = load_config()
    except ValueError as e:
        # RUN_MODE / TARGET_SCOPE / TARGET_ROW などの env 不正
        logger = setup_logger()
        logger.error(f"起動 env が不正: {e}", extra={"step": "startup_env_error"})
        return 1

    logger = setup_logger(level=config.log_level)
    rt = config.runtime
    logger.info(
        f"=== レシート OCR ジョブ開始 (run_mode={rt.run_mode}, "
        f"target_scope={rt.target_scope}, target_row={rt.target_row}) ===",
        extra={"step": "job_start"},
    )

    if not config.master.spreadsheet_id:
        logger.error("MASTER_SPREADSHEET_ID 未設定", extra={"step": "validation"})
        return 1
    # 出納帳は手動作成運用に切り替えたため、
    # テンプレートID / 出力フォルダID は必須ではない
    # （設定されていても無視される）

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
