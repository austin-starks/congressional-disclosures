import React from "react";
import { Composition } from "remotion";

import { Architecture } from "./Architecture";
import { ReadmeDemo } from "./ReadmeDemo";

const FPS = 30;

/** Six scenes, one per pattern the pipeline exercises. */
export const SCENE_FRAMES = 150;
export const SCENES = 6;

export const Root: React.FC = () => (
  <>
    <Composition
      id="Architecture"
      component={Architecture}
      durationInFrames={SCENE_FRAMES * SCENES}
      fps={FPS}
      width={1600}
      height={900}
    />
    <Composition
      id="ReadmeDemo"
      component={ReadmeDemo}
      durationInFrames={240}
      fps={FPS}
      width={1200}
      height={675}
    />
  </>
);
