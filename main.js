/**
 * main.js — 통합/UI 담당(담당 3) 산출물
 *
 * camera.js / distortion.js의 공개 함수만 사용해서 화면 흐름을 구성한다.
 * 두 파일이 실제 구현으로 교체되어도 이 파일은 수정할 필요가 없어야 한다.
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
  const resultAnalyzingEl = document.getElementById('result-analyzing');
  const resultPanelEl = document.getElementById('result-panel');
  const resultVerdictEl = document.getElementById('result-verdict');
  const resultVerdictLabelEl = document.getElementById('result-verdict-label');
  const resultScoreEl = document.getElementById('result-score');
  const resultNoteEl = document.getElementById('result-note');
  const retakeBtn = document.getElementById('retake-btn');

  // ---------- 상태 ----------
  let latestIsSafe = false;

  // ---------- 기울기 UI 갱신 ----------
  function handleTiltUpdate(angleDeg, isSafe) {
    latestIsSafe = isSafe;

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
      await initCamera(videoEl);
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
  async function handleCapture() {
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

    try {
      // analyzeDistortion은 비동기(Promise) 계약이므로 반드시 await로 받는다.
      const result = await analyzeDistortion(canvas);
      showAnalysisResult(result);
    } catch (err) {
      console.error('왜곡 분석 실패:', err);
      showAnalysisError();
    }
  }

  function showResultScreen(dataUrl) {
    resultPhotoEl.src = dataUrl;
    resultPanelEl.hidden = true;
    resultAnalyzingEl.hidden = false;
    resultNoteEl.hidden = true;

    cameraScreen.hidden = true;
    resultScreen.hidden = false;
  }

  function showAnalysisResult(result) {
    const { score, verdict, details } = result;

    resultAnalyzingEl.hidden = true;
    resultPanelEl.hidden = false;

    resultScoreEl.textContent = Math.round(score);

    resultVerdictEl.classList.remove('pass', 'retake');
    if (verdict === 'pass') {
      resultVerdictEl.classList.add('pass');
      resultVerdictLabelEl.textContent = '통과';
    } else {
      resultVerdictEl.classList.add('retake');
      resultVerdictLabelEl.textContent = '재촬영 필요';
    }

    if (details && details.confidence === 'low') {
      resultNoteEl.hidden = false;
      resultNoteEl.textContent =
        '벽선이 뚜렷하지 않아 신뢰도가 낮은 결과예요. 참고용으로만 확인해주세요.';
    } else {
      resultNoteEl.hidden = true;
    }
  }

  function showAnalysisError() {
    resultAnalyzingEl.hidden = true;
    resultPanelEl.hidden = false;
    resultScoreEl.textContent = '-';
    resultVerdictEl.classList.remove('pass', 'retake');
    resultVerdictLabelEl.textContent = '분석 실패';
    resultNoteEl.hidden = false;
    resultNoteEl.textContent = '왜곡 분석 중 오류가 발생했습니다. 다시 촬영해주세요.';
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