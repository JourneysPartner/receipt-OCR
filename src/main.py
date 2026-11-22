"""Cloud Run Job エントリポイント"""

import os
import sys
from dataclasses import replace

from src.ai.factory import create_ai_extractor
from src.compare.runner import run_compare
from src.config import load_config
from src.drive.client import DriveClient
from src.logging.logger import setup_logger
from src.ocr.factory import create_ocr_engine
from src.processing.manager import ProcessingManager
from src.rules.corrections import RuleCorrector
from src.sheets.client import MasterSheetClient


def _compare_env_names_with_values() -> list[str]:
    """値の入った COMPARE_ 環境変数の名前を返す（値はログに出さない）。"""
    return sorted(
        name for name, value in os.environ.items() if name.startswith("COMPARE_") and value != ""
    )


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

    # AI_SECOND_READER は両読みのときだけ使う（§4）。値はあっても止めない。
    if not rt.is_compare and config.ai.second_reader_model and config.ai.flow != "dual":
        logger.warning(
            "AI_SECOND_READER は AI_FLOW=dual のときだけ使います",
            extra={"step": "second_reader_flow_warning"},
        )

    # S4: 比較のつもりで本番を動かす事故を防ぐ。load_config の直後、
    # MASTER_SPREADSHEET_ID の確かめより前に行う。
    if not rt.is_compare:
        leaked = _compare_env_names_with_values()
        if leaked:
            logger.error(
                "RUN_MODE が compare 以外なのに COMPARE_ 環境変数に値があります: "
                f"{', '.join(leaked)}",
                extra={"step": "compare_env_guard"},
            )
            return 1

    logger.info(
        f"=== レシート OCR ジョブ開始 (run_mode={rt.run_mode}, "
        f"target_scope={rt.target_scope}, target_row={rt.target_row}) ===",
        extra={"step": "job_start"},
    )

    if rt.is_compare:
        # 比較ではマスター・出納帳を作らない（S1）。MASTER_SPREADSHEET_ID は不要。
        return run_compare(config)

    if not config.master.spreadsheet_id:
        logger.error("MASTER_SPREADSHEET_ID 未設定", extra={"step": "validation"})
        return 1
    # 出納帳は手動作成運用に切り替えたため、
    # テンプレートID / 出力フォルダID は必須ではない
    # （設定されていても無視される）

    try:
        cp = config.google_credentials_path
        # 作る順は今までどおり（Drive・マスター・OCR・主の読み手・もう 1 人）。
        drive = DriveClient(config.drive, cp)
        master = MasterSheetClient(config.master, cp)
        ocr = create_ocr_engine(config.ocr)
        ai = create_ai_extractor(config.ai, api_key=config.gemini_api_key)
        second_ai = None
        if config.ai.second_reader_model and config.ai.flow == "dual":
            second_config = replace(
                config.ai,
                model=config.ai.second_reader_model,
                thinking_level=config.ai.second_reader_thinking_level,
            )
            second_ai = create_ai_extractor(second_config, api_key=config.gemini_api_key)
        manager = ProcessingManager(
            config=config,
            drive=drive,
            master=master,
            ocr=ocr,
            ai=ai,
            corrector=RuleCorrector(confidence_threshold=config.ai.confidence_threshold),
            second_ai=second_ai,
        )
        summary = manager.run()
        logger.info(f"=== ジョブ完了: {summary} ===", extra={"step": "job_complete"})
        return 0
    except Exception as e:
        logger.error(f"ジョブ異常終了: {e}", extra={"step": "job_fatal"}, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
