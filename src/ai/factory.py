"""AI エンジンのファクトリ"""

from typing import Optional
from src.config import AiConfig
from src.ai.base import AiExtractor
from src.ai.gemini import GeminiExtractor


def create_ai_extractor(
    config: AiConfig, api_key: Optional[str] = None
) -> AiExtractor:
    engines = {"gemini": GeminiExtractor}
    cls = engines.get(config.engine)
    if not cls:
        raise ValueError(f"未対応AIエンジン: {config.engine}")
    return cls(config, api_key=api_key)
