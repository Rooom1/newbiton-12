/**
 * main.js — 통합/UI 담당(담당 3) 산출물
 *
 * camera.js / info.js의 공개 함수만 사용해서 화면 흐름을 구성한다.
 * 두 파일이 실제 구현으로 교체되어도 이 파일은 수정할 필요가 없어야 한다.
 *
 * 왜곡 점수(distortion.js) 기능은 실제 환경에서 동작하지 않아 제거되었고,
 * 대신 촬영 직후 촬영 시간/기기 정보/촬영 환경을 보여주는 info.js로 대체되었다.
 * info.js의 getDeviceInfo()는 비동기 함수라 fillInfoPanel/handleCapture도 async로 처리한다.
 *
 * 흐름: 시작 화면 → (촬영 시작 클릭) → 카메라 초기화 + 기울기 모니터링 시작
 *       → 촬영 → 결과 화면(시간/기기/촬영환경 카드) → 저장(누적 목록에 추가) 또는 다시 촬영
 */

(function () {
  'use strict';

  // ---------- DOM 참조 ----------
  const startScreen = document.getElementById('start-screen');
  const startBtn = document.getElementById('start-btn');

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

  const saveBtn = document.getElementById('save-btn');
  const historyListEl = document.getElementById('history-list');
  const historyCountEl = document.getElementById('history-count');

  // ---------- 상태 ----------
  let latestIsSafe = false;
  let latestTiltAngle = 90; // camera.js가 보내주는 최신 기울기 각도(도)
  let currentStream = null; // getDeviceInfo(stream)에 넘길 현재 카메라 스트림

  let latestCaptureRecord = null; // 방금 찍은 사진의 저장 대기 중인 정보 (Firestore에 저장할 압축 사진 포함)

  // 촬영된 캔버스를 작게 축소해 JPEG로 압축한다 (Firestore 문서 1MB 제한을 넉넉히 피하기 위함).
  function toCompressedDataUrl(canvas, maxWidth, quality) {
    maxWidth = maxWidth || 800;
    quality = quality || 0.7;
    const scale = Math.min(1, maxWidth / canvas.width);
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    small.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return small.toDataURL('image/jpeg', quality);
  }

  // ---------- 시작 화면 ----------
  async function handleStart() {
    startBtn.disabled = true;
    startScreen.hidden = true;
    cameraScreen.hidden = false;
    await init(); // 이 시점에 카메라 권한 요청 + 기울기 모니터링 시작
  }

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
    await fillInfoPanel(canvas, dataUrl);
  }

  function showResultScreen(dataUrl) {
    resultPhotoEl.src = dataUrl;
    resultPanelEl.hidden = false;

    cameraScreen.hidden = true;
    resultScreen.hidden = false;
  }

  // info.js의 getDeviceInfo()는 비동기라 await로 받는다. 결과는 화면에 바로
  // 채우는 동시에 latestCaptureRecord에도 담아둬서 "저장" 버튼이 그대로 쓸 수 있게 한다.
  async function fillInfoPanel(canvas, dataUrl) {
    // 갤러리/DB 저장용으로는 압축된 사진을 쓰고, 결과 화면 큰 미리보기는 원본 dataUrl을 그대로 쓴다.
    const record = { dataUrl: toCompressedDataUrl(canvas), timeText: '', deviceText: '', environmentText: '' };

    try {
      const timeInfo = getTimeInfo();
      record.timeText = formatTimeInfo(timeInfo);
    } catch (err) {
      console.error('촬영 시간 정보 조회 실패:', err);
      record.timeText = '촬영 시간 정보를 가져오지 못했어요.';
    }
    infoTimeEl.textContent = record.timeText;

    try {
      const deviceInfo = await getDeviceInfo(currentStream);
      record.deviceText = formatDeviceInfo(deviceInfo);
    } catch (err) {
      console.error('기기 정보 조회 실패:', err);
      record.deviceText = '기기 정보를 가져오지 못했어요.';
    }
    infoDeviceEl.textContent = record.deviceText;

    try {
      const environmentInfo = getEnvironmentInfo(canvas, latestTiltAngle);
      record.environmentText = formatEnvironmentInfo(environmentInfo);
    } catch (err) {
      console.error('촬영 환경 정보 조회 실패:', err);
      record.environmentText = '촬영 환경 정보를 가져오지 못했어요.';
    }
    infoEnvironmentEl.textContent = record.environmentText;

    latestCaptureRecord = record;
    saveBtn.disabled = false;
    saveBtn.textContent = '저장';
  }

  // ---------- info.js 결과 → 한국어 문장 조합 ----------
  function formatTimeInfo(info) {
    const dayPart = info.isDaytime ? '낮' : '밤';
    return `${info.displayTime} · ${dayPart}`;
  }

  function formatDeviceInfo(info) {
    const facing = formatFacingMode(info.facingMode);
    const model = info.modelLabel ? ` (${info.modelLabel})` : '';
    return `${info.platformLabel}${model} · ${info.resolution} · ${facing}`;
  }

  function formatFacingMode(facingMode) {
    if (facingMode === 'environment') return '후면 카메라';
    if (facingMode === 'user') return '전면 카메라';
    return facingMode || '카메라 방향 불명';
  }

  function formatEnvironmentInfo(info) {
    return `${info.orientation} · ${info.brightnessLevel}(${info.brightnessValue}) · ${info.tiltDescription}`;
  }

  // ---------- 저장 (Realtime Database에 기록 → 모두가 보는 공유 갤러리) ----------
  async function handleSave() {
    if (!latestCaptureRecord) return;
    if (!window.db) {
      console.error('Realtime Database가 초기화되지 않았습니다. firebase-init.js의 설정을 확인하세요.');
      saveBtn.textContent = '저장 실패 (설정 확인)';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';

    try {
      await window.db.ref('captures').push({
        dataUrl: latestCaptureRecord.dataUrl,
        timeText: latestCaptureRecord.timeText,
        deviceText: latestCaptureRecord.deviceText,
        environmentText: latestCaptureRecord.environmentText,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
      });
      saveBtn.textContent = '저장됨';
      // 목록 자체는 subscribeToHistory()의 실시간 구독이 자동으로 갱신해준다.
    } catch (err) {
      console.error('저장 실패:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = '저장 실패, 다시 시도';
    }
  }

  // Realtime Database의 captures 목록을 실시간 구독한다.
  // 누군가 저장할 때마다(같은 URL에 접속한 다른 사람 포함) 목록이 자동으로 갱신된다.
  function subscribeToHistory() {
    if (!window.db) return;
    const capturesRef = window.db.ref('captures').orderByChild('createdAt').limitToLast(50);
    capturesRef.on(
      'value',
      (snapshot) => {
        const items = [];
        snapshot.forEach((child) => {
          items.push(child.val());
        });
        items.reverse(); // 최신 저장이 목록 맨 위로 오도록
        renderHistory(items);
      },
      (err) => console.error('공유 갤러리 구독 실패:', err)
    );
  }

  function renderHistory(items) {
    historyCountEl.textContent = String(items.length);
    historyListEl.innerHTML = '';

    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'history-item';

      const img = document.createElement('img');
      img.className = 'history-item__thumb';
      img.alt = '저장된 사진';
      img.src = item.dataUrl;

      const info = document.createElement('div');
      info.className = 'history-item__info';
      info.innerHTML = `
        <p>${item.timeText}</p>
        <p>${item.deviceText}</p>
        <p>${item.environmentText}</p>
      `;

      li.appendChild(img);
      li.appendChild(info);
      historyListEl.appendChild(li);
    });
  }

  // ---------- 다시 촬영 ----------
  function handleRetake() {
    resultScreen.hidden = true;
    cameraScreen.hidden = false;

    captureBtn.disabled = !latestIsSafe;
    captureHintEl.textContent = latestIsSafe
      ? '가이드라인에 맞춰 촬영하세요'
      : '기울기를 맞추면 촬영할 수 있어요';
  }

  // ---------- 이벤트 바인딩 ----------
  startBtn.addEventListener('click', handleStart);
  captureBtn.addEventListener('click', handleCapture);
  saveBtn.addEventListener('click', handleSave);
  retakeBtn.addEventListener('click', handleRetake);

  // 공유 갤러리 구독은 페이지가 열리자마자 시작한다 (카메라 권한과는 무관).
  subscribeToHistory();

  // 카메라 초기화(init)는 더 이상 페이지 로드 시 자동 실행되지 않는다.
  // 시작 화면의 "촬영 시작" 버튼을 눌러야 handleStart() 안에서 실행된다.
})();