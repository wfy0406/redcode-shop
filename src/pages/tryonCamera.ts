export const TRYON_CAMERA_ASPECT_RATIO = 3 / 4;

export type TryOnCameraFacing = 'environment' | 'user';

// TypeScript 5.9 嘅 lib.dom 仍未列出 resizeMode；瀏覽器 Media Capture 已有呢個約束。
// 用交集補足標準欄位，唔用 any，亦唔強制舊機一定要支援。
export type TryOnPortraitVideoConstraints = MediaTrackConstraints & {
  resizeMode: { ideal: 'crop-and-scale' };
};

export type TryOnCoverCrop = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
};

// 只係 ideal 偏好，唔用 exact 趕走舊機或 WebView。瀏覽器仍可回傳原生橫向串流，
// 所以預覽及拍攝必須共用下面嘅 cover 裁切，先係真正嘅所見即所得。
export function tryOnCameraVideoConstraints(facingMode: TryOnCameraFacing): TryOnPortraitVideoConstraints {
  return {
    facingMode: { ideal: facingMode },
    aspectRatio: { ideal: TRYON_CAMERA_ASPECT_RATIO },
    resizeMode: { ideal: 'crop-and-scale' },
    width: { ideal: 1440 },
    height: { ideal: 1920 },
  };
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`);
}

// 同 CSS object-fit: cover 一樣保持原比例，置中裁走多餘位置，唔拉長或壓扁人樣。
export function getTryOnCoverCrop(
  videoWidth: number,
  videoHeight: number,
  frameWidth: number,
  frameHeight: number,
): TryOnCoverCrop {
  assertPositiveFinite(videoWidth, 'video width');
  assertPositiveFinite(videoHeight, 'video height');
  assertPositiveFinite(frameWidth, 'frame width');
  assertPositiveFinite(frameHeight, 'frame height');

  const videoRatio = videoWidth / videoHeight;
  const frameRatio = frameWidth / frameHeight;
  if (videoRatio > frameRatio) {
    const sourceWidth = videoHeight * frameRatio;
    return {
      sourceX: (videoWidth - sourceWidth) / 2,
      sourceY: 0,
      sourceWidth,
      sourceHeight: videoHeight,
    };
  }

  const sourceHeight = videoWidth / frameRatio;
  return {
    sourceX: 0,
    sourceY: (videoHeight - sourceHeight) / 2,
    sourceWidth: videoWidth,
    sourceHeight,
  };
}
