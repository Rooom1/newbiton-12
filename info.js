/**
 * info.js
 * ------------------------------------------------------------------------
 * 촬영된 사진의 "시간 / 기기 / 촬영 환경" 정보를 보여주는 카드용 데이터를
 * 만드는 순수 JS 모듈입니다. (OpenCV 기반 왜곡 점수 계산 기능을 대체)
 *
 * 빌드 도구 없이 <script src="info.js"></script> 로 그대로 로드해서 쓸 수
 * 있도록 작성되었습니다 (모듈 문법 없음, 전역 함수로 노출).
 *
 * 세 함수 모두 "동기" 함수이며, 실패하더라도 예외를 던지지 않고 안전한
 * 기본값을 채워 항상 유효한 객체를 반환합니다(카드 렌더링이 절대 깨지지
 * 않도록 하기 위함).
 *
 * 공개 API
 *   - getTimeInfo(): { timestamp, displayTime, isDaytime }
 *   - getDeviceInfo(stream): { platformLabel, resolution, facingMode }
 *   - getEnvironmentInfo(canvas, tiltAngleDeg): { orientation, brightnessLevel, brightnessValue, tiltDescription }
 *
 * 범위에서 제외된 것: 지면으로부터의 높이, GPS 위치 정보 (정확도 문제로 제외)
 * ------------------------------------------------------------------------
 */

/* ============================== 설정값 ================================
 * 실제 사진들로 테스트하면서 아래 임계값만 조정하면 됩니다.
 * ====================================================================== */
var INFO_CONFIG = {
  // 낮/밤 판정 기준 (시(hour) 단위, 양 끝 포함)
  DAYTIME_START_HOUR: 6,
  DAYTIME_END_HOUR: 18,

  // 밝기 판정에 사용할 다운샘플 크기(px) — 작을수록 빠르고 결정론적
  BRIGHTNESS_SAMPLE_SIZE: 50,
  // 평균 밝기(0~255) 임계값
  BRIGHTNESS_DARK_MAX: 80, // 이 값 미만이면 "어두움"
  BRIGHTNESS_BRIGHT_MIN: 180, // 이 값 초과면 "밝음"

  // 촬영 각도 판정: tiltAngleDeg는 90도가 수평 기준
  TILT_SAFE_RANGE_DEG: 15, // |tiltAngleDeg - 90| 이 이 값 이상이면 위/아래로 판정
};

/* ============================ 1) 시간 정보 ============================== */

/**
 * 현재 시각 정보를 반환합니다.
 * @returns {{timestamp:string, displayTime:string, isDaytime:boolean}}
 */
function getTimeInfo() {
  var now = new Date();
  var hour = now.getHours();
  var isDaytime = hour >= INFO_CONFIG.DAYTIME_START_HOUR && hour <= INFO_CONFIG.DAYTIME_END_HOUR;

  return {
    timestamp: now.toISOString(),
    displayTime: now.toLocaleString('ko-KR'),
    isDaytime: isDaytime,
  };
}

/* ============================ 2) 기기 정보 ============================== */

/** navigator.userAgent를 검사해서 대략적인 플랫폼 라벨을 판정합니다. */
function _detectPlatformLabel() {
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

  if (/iPhone|iPad|iPod/i.test(ua)) {
    return 'iOS / Safari';
  }
  if (/Android/i.test(ua)) {
    return 'Android / Chrome';
  }
  return 'Desktop';
}

/**
 * 촬영에 사용된 MediaStream을 바탕으로 기기 정보를 반환합니다.
 * stream이 없거나 트랙 정보를 읽을 수 없어도 예외를 던지지 않고
 * 안전한 기본값을 채워 반환합니다.
 *
 * @param {MediaStream} stream - getUserMedia로 받은 스트림
 * @returns {{platformLabel:string, resolution:string, facingMode:string}}
 */
function getDeviceInfo(stream) {
  var platformLabel = _detectPlatformLabel();
  var resolution = 'Unknown';
  var facingMode = 'unknown';

  try {
    var videoTracks =
      stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    var track = videoTracks && videoTracks[0];

    if (track && typeof track.getSettings === 'function') {
      var settings = track.getSettings() || {};
      if (settings.width && settings.height) {
        resolution = settings.width + 'x' + settings.height;
      }
      if (settings.facingMode) {
        facingMode = settings.facingMode;
      }
    }
  } catch (e) {
    // 스트림 정보를 못 읽어도 카드 자체는 항상 렌더링될 수 있도록 기본값 유지
  }

  return {
    platformLabel: platformLabel,
    resolution: resolution,
    facingMode: facingMode,
  };
}

/* ============================ 3) 촬영 환경 정보 ========================== */

/**
 * 캔버스를 작은 크기로 축소해 그린 뒤 평균 밝기(0~255, 표준 휘도 가중치)를
 * 계산합니다. 가볍고 결정론적으로 동작하도록 OpenCV 없이 순수 Canvas 2D
 * API만 사용합니다. 어떤 이유로든 픽셀을 읽을 수 없으면(예: 캔버스가
 * cross-origin 오염 상태) null을 반환합니다.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {number|null}
 */
function _computeAverageBrightness(canvas) {
  var size = INFO_CONFIG.BRIGHTNESS_SAMPLE_SIZE;
  try {
    var sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = size;
    sampleCanvas.height = size;
    var ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, size, size);

    var imageData = ctx.getImageData(0, 0, size, size).data;
    var total = 0;
    var pixelCount = imageData.length / 4;

    for (var i = 0; i < imageData.length; i += 4) {
      var r = imageData[i];
      var g = imageData[i + 1];
      var b = imageData[i + 2];
      // 표준 휘도(luma) 가중치: 사람 눈이 초록에 더 민감한 특성을 반영
      total += 0.299 * r + 0.587 * g + 0.114 * b;
    }

    return total / pixelCount;
  } catch (e) {
    return null;
  }
}

/**
 * 촬영 환경(화면 방향 / 밝기 / 촬영 각도 설명)을 반환합니다.
 *
 * @param {HTMLCanvasElement} canvas - 촬영된 사진이 그려진 캔버스
 * @param {number} tiltAngleDeg - 촬영 순간의 기울기 각도(90도 = 수평)
 * @returns {{orientation:string, brightnessLevel:string, brightnessValue:(number|null), tiltDescription:string}}
 */
function getEnvironmentInfo(canvas, tiltAngleDeg) {
  var orientation = '세로';
  var brightnessValue = null;
  var brightnessLevel = '알 수 없음';
  var tiltDescription = '촬영 각도 정보 없음';

  if (canvas && typeof canvas.width === 'number' && typeof canvas.height === 'number') {
    orientation = canvas.width >= canvas.height ? '가로' : '세로';

    brightnessValue = _computeAverageBrightness(canvas);
    if (brightnessValue !== null) {
      if (brightnessValue < INFO_CONFIG.BRIGHTNESS_DARK_MAX) {
        brightnessLevel = '어두움';
      } else if (brightnessValue > INFO_CONFIG.BRIGHTNESS_BRIGHT_MIN) {
        brightnessLevel = '밝음';
      } else {
        brightnessLevel = '보통';
      }
    }
  }

  if (typeof tiltAngleDeg === 'number' && !isNaN(tiltAngleDeg)) {
    var diffFromLevel = tiltAngleDeg - 90;
    var range = INFO_CONFIG.TILT_SAFE_RANGE_DEG;

    if (diffFromLevel <= -range) {
      // 카메라가 위를 향함 (예: 90도보다 15도 이상 작음)
      tiltDescription = '낮은 위치에서 위쪽을 향해 촬영됨 (천장이 과장되어 보일 수 있음)';
    } else if (diffFromLevel >= range) {
      // 카메라가 아래를 향함
      tiltDescription = '높은 위치에서 아래쪽을 향해 촬영됨 (바닥이 과장되어 보일 수 있음)';
    } else {
      tiltDescription = '수평에 가깝게 촬영됨';
    }
  }

  return {
    orientation: orientation,
    brightnessLevel: brightnessLevel,
    brightnessValue: brightnessValue,
    tiltDescription: tiltDescription,
  };
}

// 명시적으로 전역에 노출 (module 태그 없이 <script>로 로드되므로 사실상
// 이미 전역이지만, 방어적으로 한 번 더 지정합니다.)
if (typeof window !== 'undefined') {
  window.getTimeInfo = getTimeInfo;
  window.getDeviceInfo = getDeviceInfo;
  window.getEnvironmentInfo = getEnvironmentInfo;
  window.INFO_CONFIG = INFO_CONFIG;
}