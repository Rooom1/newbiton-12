/**
 * main.js — 통합/UI 담당(담당 3) 산출물
 *
 * camera.js / info.js의 공개 함수만 사용해서 화면 흐름을 구성한다.
 * 두 파일이 실제 구현으로 교체되어도 이 파일은 수정할 필요가 없어야 한다.
 *
 * 왜곡 점수(distortion.js) 기능은 실제 환경에서 동작하지 않아 제거되었고,
 * 대신 촬영 직후 촬영 시간/기기 정보/촬영 환경을 보여주는 info.js로 대체되었다.
 * info.js의 세 함수(getTimeInfo, getDeviceInfo, getEnvironmentInfo)는 모두
 * 동기 함수이므로 별도의 "분석 중" 로딩 상태가 필요 없다.
 */

(function () {
  'use strict';

  // ---------- DOM 참조 ----------
  const videoEl = document.getElementById('camera-preview');
  const tiltWarningEl = document.getElementById('tilt-warning');
  const tiltWarningTextEl = document.getElementById('tilt-warning-text');
  const tiltAngleEl = document.getElementById('tilt-angle');
  const tiltPermissionBtn = document.getElementById('tilt-permission-btn');
  const cameraErrorEl = document.getElementById('camera-error');

  const captureBtn = document.getElementById('capture-btn');
  const captureHintEl = document.getElementById('capture-hint');

  const cameraScreen = document.getElementById('camera-screen');
  const resultScreen = document.getElementById('result-screen');
  const resultPhotoEl = document.getElementById('result-photo');
  const resultPanelEl = document.getElementById('result-panel');
  const infoTimeEl = document.getElementById('info-time');
  const infoDeviceEl = document.getElementById('info-device');
  const infoEnvironmentEl = document.getElementById('info-environment');
  const retakeBtn = document.getElementById('retake-btn');

  // ---------- 상태 ----------
  let latestIsSafe = false;
  let latestTiltAngle = 90; // camera.js가 보내주는 최신 기울기 각도(도)
  let currentStream = null; // getDeviceInfo(stream)에 넘길 현재 카메라 스트림

  // ---------- 기울기 UI 갱신 ----------
  function handleTiltUpdate(angleDeg, isSafe) {
    latestIsSafe = isSafe;
    latestTiltAngle = angleDeg;

    tiltWarningEl.hidden = isSafe;
    if (!isSafe) {
      tiltWarningTextEl.textContent = '카메라를 수평으로 맞춰주세요';
    }
    tiltAngleEl.textContent = Number.isFinite(angleDeg)
      ? `(${angleDeg.toFixed(1)}°)`
      : '';

    // 결과 화면이 떠 있는 동안에는 촬영 버튼 상태를 건드리지 않는다.
    if (resultScreen.hidden) {
      captureBtn.disabled = !isSafe;
      captureHintEl.textContent = isSafe
        ? '가이드라인에 맞춰 촬영하세요'
        : '기울기를 맞추면 촬영할 수 있어요';
    }
  }

  function startMonitoring() {
    startTiltMonitor(handleTiltUpdate);
  }

  // ---------- 초기화: 카메라 + 기울기 모니터링 ----------
  async function init() {
    try {
      currentStream = await initCamera(videoEl);
    } catch (err) {
      console.error('카메라 초기화 실패:', err);
      cameraErrorEl.hidden = false;
      captureHintEl.textContent = '카메라를 사용할 수 없습니다';
      return;
    }

    // 실제 구현에서 iOS 13+ 대응용 requestTiltPermission()이 추가되는 경우를
    // 대비한 방어적 분기. 스텁에는 존재하지 않으므로 바로 모니터링을 시작한다.
    if (typeof requestTiltPermission === 'function') {
      tiltPermissionBtn.hidden = false;
      captureHintEl.textContent = '기울기 센서 권한을 허용해주세요';
      tiltPermissionBtn.addEventListener(
        'click',
        async () => {
          try {
            await requestTiltPermission();
          } catch (err) {
            console.warn('기울기 센서 권한 요청 실패:', err);
          }
          tiltPermissionBtn.hidden = true;
          startMonitoring();
        },
        { once: true }
      );
    } else {
      startMonitoring();
    }
  }

  // ---------- 촬영 ----------
  function handleCapture() {
    if (captureBtn.disabled) return;

    captureBtn.disabled = true;

    let dataUrl, canvas;
    try {
      ({ dataUrl, canvas } = capturePhoto(videoEl));
    } catch (err) {
      console.error('촬영 실패:', err);
      captureBtn.disabled = !latestIsSafe;
      return;
    }

    showResultScreen(dataUrl);
    fillInfoPanel(canvas);
  }

  function showResultScreen(dataUrl) {
    resultPhotoEl.src = dataUrl;
    resultPanelEl.hidden = false;

    cameraScreen.hidden = true;
    resultScreen.hidden = false;
  }

  // info.js의 세 함수는 모두 동기 함수라 로딩 스피너 없이 바로 결과를 채운다.
  function fillInfoPanel(canvas) {
    try {
      const timeInfo = getTimeInfo();
      infoTimeEl.textContent = formatTimeInfo(timeInfo);
    } catch (err) {
      console.error('촬영 시간 정보 조회 실패:', err);
      infoTimeEl.textContent = '촬영 시간 정보를 가져오지 못했어요.';
    }

    try {
      const deviceInfo = getDeviceInfo(currentStream);
      infoDeviceEl.textContent = formatDeviceInfo(deviceInfo);
    } catch (err) {
      console.error('기기 정보 조회 실패:', err);
      infoDeviceEl.textContent = '기기 정보를 가져오지 못했어요.';
    }

    try {
      const environmentInfo = getEnvironmentInfo(canvas, latestTiltAngle);
      infoEnvironmentEl.textContent = formatEnvironmentInfo(environmentInfo);
    } catch (err) {
      console.error('촬영 환경 정보 조회 실패:', err);
      infoEnvironmentEl.textContent = '촬영 환경 정보를 가져오지 못했어요.';
    }
  }

  // ---------- info.js 결과 → 한국어 문장 조합 ----------
  function formatTimeInfo(info) {
    const dayPart = info.isDaytime ? '낮' : '밤';
    return `${info.displayTime} · ${dayPart}`;
  }

  function formatDeviceInfo(info) {
    const facing = formatFacingMode(info.facingMode);
    return `${info.platformLabel} · ${info.resolution} · ${facing}`;
  }

  function formatFacingMode(facingMode) {
    if (facingMode === 'environment') return '후면 카메라';
    if (facingMode === 'user') return '전면 카메라';
    return facingMode || '카메라 방향 불명';
  }

  function formatEnvironmentInfo(info) {
    return `${info.orientation} · ${info.brightnessLevel}(${info.brightnessValue}) · ${info.tiltDescription}`;
  }

  function handleRetake() {
    resultScreen.hidden = true;
    cameraScreen.hidden = false;

    captureBtn.disabled = !latestIsSafe;
    captureHintEl.textContent = latestIsSafe
      ? '가이드라인에 맞춰 촬영하세요'
      : '기울기를 맞추면 촬영할 수 있어요';
  }

  // ---------- 이벤트 바인딩 ----------
  captureBtn.addEventListener('click', handleCapture);
  retakeBtn.addEventListener('click', handleRetake);

  init();
})();