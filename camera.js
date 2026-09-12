/**
 * camera.js
 * 담당 1 — 카메라 연결 / 기울기 센서 모듈
 *
 * 빌드 도구 없이 <script src="camera.js"></script> 로 바로 로드하는 순수 JS.
 * 아래 함수들은 전역(window) 함수로 선언되어 다른 스크립트(main.js 등)에서
 * 바로 호출할 수 있다.
 *
 * 제공 함수:
 *   - async function initCamera(videoEl)
 *   - function startTiltMonitor(callback)
 *   - function stopTiltMonitor()                (보너스: 필요 시 모니터링 중지)
 *   - async function requestTiltPermission()
 *   - function capturePhoto(videoEl)
 */

// ----------------------------------------------------------------
// 설정값
// ----------------------------------------------------------------

// 기울기 안전 범위: 폰을 수직으로 세워 촬영하는 상태(beta ≈ 90도)를 기준으로
// ±15도 이내면 안전(isSafe = true)으로 판단한다.
const TILT_SAFE_CENTER_DEG = 90;
const TILT_SAFE_THRESHOLD_DEG = 15;

// ----------------------------------------------------------------
// 1. 카메라 연결
// ----------------------------------------------------------------

/**
 * 카메라 스트림을 받아 videoEl.srcObject에 연결한다.
 * 가능하면 후면 카메라(facingMode: 'environment')를 우선 사용하고,
 * 지원하지 않는 기기/브라우저에서는 단계적으로 완화된 조건으로 재시도한다.
 *
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<MediaStream>} 연결된 스트림 (성공 시)
 * @throws {Error} 권한 거부, 카메라 없음 등 사용자에게 보여줄 수 있는 메시지를 담은 에러
 */
async function initCamera(videoEl) {
  if (!videoEl) {
    throw new Error('initCamera(videoEl): video 엘리먼트가 필요합니다.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('이 브라우저는 카메라 접근(getUserMedia)을 지원하지 않습니다.');
  }

  // 후면 카메라 강제 -> 후면 카메라 선호 -> 아무 카메라나, 순서로 재시도
  const constraintsAttempts = [
    { video: { facingMode: { exact: 'environment' } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];

  let lastError = null;

  for (const constraints of constraintsAttempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      videoEl.srcObject = stream;
      // iOS 사파리에서 전체화면으로 전환되지 않고 인라인 재생되도록 함
      videoEl.setAttribute('playsinline', 'true');
      videoEl.setAttribute('muted', 'true');
      videoEl.muted = true;

      await new Promise((resolve) => {
        if (videoEl.readyState >= 1 /* HAVE_METADATA */) {
          resolve();
          return;
        }
        videoEl.onloadedmetadata = () => resolve();
      });

      try {
        await videoEl.play();
      } catch (playErr) {
        // 일부 브라우저는 사용자 제스처 없이 play()가 막힐 수 있음.
        // 스트림 연결 자체는 성공했으므로 에러로 취급하지 않고 넘어간다.
        console.warn('video.play() 자동 재생 실패(사용자 상호작용 후 재생될 수 있음):', playErr);
      }

      return stream;
    } catch (err) {
      lastError = err;
      // 다음 constraints로 재시도
    }
  }

  // 모든 시도가 실패한 경우, 사용자에게 보여줄 수 있는 친절한 메시지로 변환
  let message = '카메라를 시작할 수 없습니다.';
  if (lastError) {
    switch (lastError.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        message = '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 권한을 허용해주세요.';
        break;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        message = '사용 가능한 카메라를 찾을 수 없습니다.';
        break;
      case 'NotReadableError':
      case 'TrackStartError':
        message = '카메라가 다른 앱에서 사용 중이거나 하드웨어 오류가 발생했습니다.';
        break;
      case 'OverconstrainedError':
        message = '요청한 카메라 조건(후면 카메라 등)을 만족하는 카메라가 없습니다.';
        break;
      default:
        message = `카메라를 시작할 수 없습니다. (${lastError.name || lastError.message})`;
    }
  }

  const error = new Error(message);
  error.cause = lastError;
  throw error;
}

// ----------------------------------------------------------------
// 2. 기울기 센서 모니터링
// ----------------------------------------------------------------

let _tiltHandler = null;

/**
 * DeviceOrientationEvent를 이용해 폰의 상하 기울기(beta)를 모니터링한다.
 * 폰을 수직으로 세운 상태(beta ≈ 90도)를 안전으로 보고,
 * |beta - 90| 이 15도를 넘으면 isSafe = false로 판단한다.
 *
 * 기울기 값이 변할 때마다 callback(angleDeg, isSafe) 형태로 호출된다.
 *
 * 주의: iOS 13 이상에서는 이 함수를 호출하기 전에 반드시
 * requestTiltPermission()으로 사용자 동의를 먼저 받아야 이벤트가 발생한다.
 *
 * @param {(angleDeg: number, isSafe: boolean) => void} callback
 */
function startTiltMonitor(callback) {
  if (typeof callback !== 'function') {
    throw new Error('startTiltMonitor(callback): callback 함수가 필요합니다.');
  }

  if (typeof window.DeviceOrientationEvent === 'undefined') {
    console.warn('이 기기/브라우저는 DeviceOrientationEvent를 지원하지 않습니다.');
    return;
  }

  // 중복 등록 방지: 이미 모니터링 중이면 기존 리스너 제거 후 재등록
  if (_tiltHandler) {
    window.removeEventListener('deviceorientation', _tiltHandler);
  }

  _tiltHandler = function (event) {
    const beta = event.beta; // 상하 기울기(front-to-back tilt). 0 = 평평하게 눕힘, 90 = 수직으로 세움
    if (beta === null || beta === undefined || Number.isNaN(beta)) {
      return; // 센서 값이 아직 없는 경우 무시
    }
    const angleDeg = beta;
    const isSafe = Math.abs(angleDeg - TILT_SAFE_CENTER_DEG) <= TILT_SAFE_THRESHOLD_DEG;
    callback(angleDeg, isSafe);
  };

  window.addEventListener('deviceorientation', _tiltHandler);
}

/**
 * startTiltMonitor로 등록한 리스너를 해제한다. (필수 요구사항은 아니지만
 * 화면 전환/정리 시 사용할 수 있도록 제공)
 */
function stopTiltMonitor() {
  if (_tiltHandler) {
    window.removeEventListener('deviceorientation', _tiltHandler);
    _tiltHandler = null;
  }
}

/**
 * iOS 13 이상에서 DeviceOrientationEvent 사용을 위해 필요한 사용자 권한을 요청한다.
 * 반드시 버튼 클릭 같은 사용자 제스처(이벤트 핸들러) 안에서 호출해야 한다.
 * iOS가 아니거나 권한 요청이 필요 없는 환경에서는 즉시 true를 반환한다.
 *
 * @returns {Promise<boolean>} 권한이 허용되었는지 여부
 */
async function requestTiltPermission() {
  const DOE = window.DeviceOrientationEvent;

  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      const result = await DOE.requestPermission(); // 'granted' | 'denied'
      return result === 'granted';
    } catch (err) {
      console.error('기울기 센서 권한 요청 중 오류:', err);
      return false;
    }
  }

  // Android 등 별도 권한 요청이 필요 없는 환경
  return true;
}

// ----------------------------------------------------------------
// 3. 촬영
// ----------------------------------------------------------------

/**
 * 현재 video 프레임을 canvas에 그려서 반환한다.
 *
 * @param {HTMLVideoElement} videoEl
 * @returns {{ dataUrl: string, canvas: HTMLCanvasElement }}
 */
function capturePhoto(videoEl) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
    throw new Error('capturePhoto(videoEl): 비디오 스트림이 아직 준비되지 않았습니다.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/png');

  return { dataUrl, canvas };
}