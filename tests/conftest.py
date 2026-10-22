"""Hypothesis の実行プロファイル設定"""

import os

from hypothesis import settings

settings.register_profile("ci", derandomize=True, max_examples=100, deadline=None)
settings.register_profile("dev", max_examples=500, deadline=None)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "ci"))
