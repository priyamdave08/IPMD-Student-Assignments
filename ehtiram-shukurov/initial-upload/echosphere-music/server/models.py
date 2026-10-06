from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Mood = Literal['warm', 'calm', 'sad', 'anger']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class FocusPoint(StrictModel):
    time: float = Field(ge=0, le=60)
    cx: float = Field(gt=0, lt=1)
    cy: float = Field(gt=0, lt=1)
    rx: float = Field(ge=.025, le=.5)
    ry: float = Field(ge=.025, le=.5)

    @model_validator(mode='after')
    def bounds(self):
        if self.cx - self.rx < -1e-6 or self.cx + self.rx > 1.000001 or self.cy - self.ry < -1e-6 or self.cy + self.ry > 1.000001:
            raise ValueError('Keep the focus ellipse inside the video frame.')
        return self


class AnalysisRequest(StrictModel):
    focus: list[FocusPoint] = Field(min_length=1, max_length=16)
    analyzer: Literal['measurements', 'qwen'] = 'measurements'

    @model_validator(mode='after')
    def ordered(self):
        times = [p.time for p in self.focus]
        if times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError('Focus points must start at 0 and have increasing times.')
        return self


class SoundtrackRequest(StrictModel):
    video_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    mood: Literal['auto', 'warm', 'calm', 'sad', 'anger'] = 'auto'
    engine: Literal['composer', 'ace', 'library'] = 'composer'
    seed: int = Field(default=42, ge=0, le=4294967295)


class AutoOptions(StrictModel):
    """Options for POST /v1/soundtracks/auto. Explicit input modes; nothing is guessed silently."""
    input_mode: Literal['robot', 'sphere', 'focus']
    mood: Literal['auto', 'warm', 'calm', 'sad', 'anger'] = 'auto'
    on_ambiguous: Literal['fail', 'best_guess'] = 'fail'
    engine: Literal['library', 'composer'] = 'library'
    seed: int = Field(default=42, ge=0, le=4294967295)
    focus: list[FocusPoint] | None = Field(default=None, min_length=1, max_length=16)

    @model_validator(mode='after')
    def consistent(self):
        if self.input_mode == 'focus':
            if not self.focus:
                raise ValueError("input_mode 'focus' requires focus points.")
            times = [p.time for p in self.focus]
            if times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])):
                raise ValueError('Focus points must start at 0 and have increasing times.')
        elif self.focus:
            raise ValueError("focus points are only accepted with input_mode 'focus'.")
        return self


class VisionResult(StrictModel):
    mood: Mood | None
    observations: list[str] = Field(min_length=1, max_length=6)
    ambiguous: bool
