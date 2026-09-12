/**
 * info.js
 * ------------------------------------------------------------------------
 * 촬영된 사진의 "시간 / 기기 / 촬영 환경" 정보를 보여주는 카드용 데이터를
 * 만드는 순수 JS 모듈입니다. (OpenCV 기반 왜곡 점수 계산 기능을 대체)
 *
 * 빌드 도구 없이 <script src="info.js"></script> 로 그대로 로드해서 쓸 수
 * 있도록 작성되었습니다 (모듈 문법 없음, 전역 함수로 노출).
 *
 * getTimeInfo(), getEnvironmentInfo()는 "동기" 함수입니다.
 *
 * ⚠️ getDeviceInfo(stream)는 "비동기(async)" 함수입니다. 정확한 기종명을
 * 얻으려면 User-Agent Client Hints API를 호출해야 하는데 이 API가 Promise
 * 기반이라, 기존에 동기 함수였던 것을 async로 바꿨습니다(프로젝트 문서
 * 10번 항목에서 이미 이렇게 합의된 내용과 동일한 형태로 맞췄습니다).
 * 호출하는 쪽에서는 `const info = await getDeviceInfo(stream);` 또는
 * `getDeviceInfo(stream).then(info => {...})` 형태로 받아야 합니다.
 *
 * 모든 함수는 실패하더라도 예외를 던지지 않고 안전한 기본값을 채워 항상
 * 유효한 객체를 반환합니다(카드 렌더링이 절대 깨지지 않도록 하기 위함).
 *
 * 공개 API
 *   - getTimeInfo(): { timestamp, displayTime, isDaytime }
 *   - getDeviceInfo(stream): Promise<{ platformLabel, modelLabel, resolution, facingMode }>
 *   - getEnvironmentInfo(canvas, tiltAngleDeg): { orientation, brightnessLevel, brightnessValue, tiltDescription }
 *
 * 범위에서 제외된 것: 지면으로부터의 높이, GPS 위치 정보 (정확도 문제로 제외)
 *
 * ⚠️ 기종(modelLabel)에 대한 중요한 제약사항
 *   - iOS/Safari: Apple이 개인정보 보호 정책상 웹에 정확한 기종명을 절대
 *     노출하지 않습니다("iPhone"까지만 알 수 있고 "iPhone 15 Pro" 같은
 *     구체적인 모델명은 어떤 JS API로도 얻을 수 없습니다). 우회 방법 없음
 *     → iOS에서는 modelLabel이 항상 null입니다.
 *   - Android/Chrome: 최신 Chrome(대략 110+ 버전)은 "User-Agent Reduction"
 *     정책으로 기본 navigator.userAgent에서 기종명을 "K" 같은 임의 값으로
 *     감춰서, platformLabel이 "Android / Chrome"으로만 보이는 게 원인이었습니다.
 *     이를 보완하기 위해 1) navigator.userAgent에서 best-effort로 먼저
 *     추출을 시도하고(일부 기기·브라우저는 아직 축소되지 않은 UA를 보냄),
 *     2) User-Agent Client Hints API(navigator.userAgentData.getHighEntropyValues)
 *     가 있으면 그 결과로 덮어써서 더 정확한 값을 우선 사용합니다.
 *     Client Hints는 Chrome/Edge/Samsung Internet 등 Chromium 계열에서만
 *     지원되고, Firefox에서는 API 자체가 없어 UA 기반 값(있으면)이나
 *     null로 남습니다.
 *   - 삼성 등 일부 제조사는 "Galaxy S23" 같은 마케팅명이 아니라
 *     "SM-S911N" 같은 내부 모델코드를 반환하는 경우가 많습니다. 이번
 *     범위에서는 코드→마케팅명 매핑 없이 받은 값을 그대로 노출합니다.
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
 * navigator.userAgent 문자열에서 기종명을 최선을 다해(best-effort) 동기적으로
 * 추출합니다. 예: "Mozilla/5.0 (Linux; Android 13; SM-S911N) ..." -> "SM-S911N"
 *
 * 최신 Chrome은 User-Agent Reduction 정책 때문에 이 값이 실제 기종명 대신
 * 임의 placeholder("K")로 나오는 경우가 많습니다 — 이때는 null을 반환하며,
 * getDeviceInfo()가 이어서 Client Hints로 재시도합니다. iOS는 애초에 UA에
 * 기종명이 들어가지 않으므로 항상 null입니다.
 *
 * @returns {string|null}
 */
function _extractModelFromUserAgent() {
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var match = ua.match(/Android\s*[\d.]*;\s*([^)]+)\)/i);
  if (!match || !match[1]) return null;

  var raw = match[1].split('Build/')[0].trim();
  // Chrome 축소된 UA의 placeholder("K") 등 의미 없는 값은 걸러냄
  if (!raw || /^k$/i.test(raw) || /^wv$/i.test(raw)) return null;

  return raw;
}

/**
 * User-Agent Client Hints API로 정확한 기종명을 비동기로 조회합니다.
 * Chrome/Edge/Samsung Internet 등 Chromium 계열 브라우저에서만 동작하고,
 * 그 외(Safari, Firefox 등)에서는 API 자체가 없어 null을 반환합니다.
 *
 * @returns {Promise<string|null>}
 */
async function _getModelFromClientHints() {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.userAgentData ||
      typeof navigator.userAgentData.getHighEntropyValues !== 'function'
    ) {
      return null;
    }
    var values = await navigator.userAgentData.getHighEntropyValues(['model']);
    return values && values.model ? values.model : null;
  } catch (e) {
    return null;
  }
}

/**
 * 촬영에 사용된 MediaStream을 바탕으로 기기 정보를 반환합니다.
 * stream이 없거나 트랙 정보를 읽을 수 없어도 예외를 던지지 않고
 * 안전한 기본값을 채워 반환합니다.
 *
 * ⚠️ 비동기 함수입니다 — 반드시 await 하거나 .then()으로 받으세요.
 *
 * modelLabel 계산 순서: 1) navigator.userAgent에서 best-effort로 먼저
 * 추출 시도 → 2) User-Agent Client Hints가 지원되면 그 결과로 덮어써서
 * 더 정확한 값을 우선 사용. 둘 다 실패하면 null(기종을 알 수 없음 —
 * UI에서는 이 경우 기종 표기를 생략하고 platformLabel만 보여주는 것을
 * 권장).
 *
 * @param {MediaStream} stream - getUserMedia로 받은 스트림
 * @returns {Promise<{platformLabel:string, modelLabel:(string|null), resolution:string, facingMode:string}>}
 */
async function getDeviceInfo(stream) {
  var platformLabel = _detectPlatformLabel();
  var resolution = 'Unknown';
  var facingMode = 'unknown';
  var modelLabel = _extractModelFromUserAgent();

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

  var clientHintModel = await _getModelFromClientHints();
  if (clientHintModel) {
    modelLabel = clientHintModel; // Client Hints가 있으면 UA 추출값보다 신뢰도가 높음
  }

  return {
    platformLabel: platformLabel,
    modelLabel: modelLabel,
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