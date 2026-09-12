/**
 * distortion.js
 * ------------------------------------------------------------------------
 * 부동산 매물 사진의 "직선 왜곡(초광각 렌즈 왜곡 / 과도한 기울기)" 정도를
 * 0~100 사이의 점수로 계산하는 순수 JS 모듈입니다.
 *
 * 빌드 도구 없이 <script src="distortion.js"></script> 로 그대로 로드해서
 * 쓸 수 있도록 작성되었습니다 (모듈 문법 없음, 전역 함수로 노출).
 *
 * 사용 전제:
 *   - OpenCV.js 가 아래처럼 CDN으로 로드되어 있어야 합니다.
 *       <script async src="https://docs.opencv.org/4.x/opencv.js"></script>
 *   - OpenCV.js 는 비동기로 초기화되므로, 이 파일은 내부적으로
 *     waitForOpenCV() 로 준비될 때까지 기다린 뒤 처리합니다.
 *
 * 공개 API
 *   - waitForOpenCV(timeoutMs?): Promise<cv>
 *       OpenCV.js(전역 cv)가 실제로 쓸 수 있는 상태가 될 때까지 기다립니다.
 *   - analyzeDistortion(canvas, options?): Promise<{ score, verdict, details }>
 *       사진 한 장(캔버스)의 왜곡 점수를 계산합니다.
 *
 * ⚠️ analyzeDistortion 은 "비동기(async) 함수"입니다.
 *    OpenCV.js 로딩을 기다려야 하기 때문에 동기적으로 결과를 반환할 수
 *    없습니다. 함수 이름과 파라미터(canvas)는 요구된 시그니처를 그대로
 *    따르되, 호출하는 쪽에서는 반드시 아래처럼 사용해야 합니다.
 *
 *      const result = await analyzeDistortion(canvas);
 *      // 또는
 *      analyzeDistortion(canvas).then((result) => { ... });
 *
 *    OpenCV.js 로드 실패/타임아웃, 잘못된 입력 등 처리에 실패한 경우에는
 *    정상적인 결과 객체 대신 Promise 가 reject 되므로, 호출부에서는
 *    try/catch (또는 .catch)로 감싸서 실패를 처리해 주세요.
 * ------------------------------------------------------------------------
 */

/* ============================== 설정값 ================================
 * 해커톤 중 실제 사진으로 테스트하면서 아래 상수들만 조정하면 됩니다.
 * ====================================================================== */
var DISTORTION_CONFIG = {
  // 처리 속도를 위해 내부적으로 리사이즈할 최대 변 길이(px).
  // 결과로 반환되는 직선 좌표는 원본 캔버스 크기 기준으로 다시 환산됩니다.
  MAX_PROCESS_DIM: 1280,

  // Gaussian Blur 커널 크기
  BLUR_KSIZE: 5,

  // Canny 임계값을 이미지 밝기 중앙값 기반으로 자동 계산할 때 쓰는 계수
  CANNY_SIGMA: 0.33,

  // HoughLinesP 파라미터 (이미지 대각선 길이에 비례해서 자동 계산)
  HOUGH_THRESHOLD: 40,
  HOUGH_MIN_LINE_LENGTH_RATIO: 0.05, // 대각선 길이 대비 최소 직선 길이
  HOUGH_MAX_LINE_GAP_RATIO: 0.02,

  // 같은 물리적 모서리를 중복 검출한 직선을 하나로 합치기 위한 기준
  DEDUP_ANGLE_TOL_DEG: 8,
  DEDUP_DIST_TOL_RATIO: 0.015,

  // 잔차(곡률) 계산 시 직선 후보 하나당 사용할 샘플링 설정
  RESIDUAL_SAMPLE_STEP_PX: 4,
  RESIDUAL_EXTEND_RATIO: 0.15, // 검출된 선분 양끝을 살짝 연장해서 더 살펴봄
  RESIDUAL_HALF_WINDOW_PX: 8, // 직선에 수직 방향으로 엣지를 찾을 반경
  RESIDUAL_MIN_SAMPLES: 8,
  RESIDUAL_MIN_COVERAGE: 0.35, // 샘플 중 실제 엣지가 잡힌 비율이 이보다 낮으면 신뢰 안 함

  // 후보 직선이 너무 많으면 상위 N개(길이 기준)만 사용
  MAX_CANDIDATE_LINES: 30,

  // Canny 엣지 비율(전체 픽셀 대비 엣지 픽셀 비율)이 이 범위를 벗어나면
  // 임계값을 자동으로 낮추거나/높여서 재시도합니다. (밝은 벽/저대비 사진 등에서
  // median 기반 자동 임계값만으로는 엣지가 거의 검출되지 않는 문제를 보완)
  CANNY_MIN_EDGE_RATIO: 0.01,
  CANNY_MAX_EDGE_RATIO: 0.15,
  CANNY_MAX_ATTEMPTS: 4,

  // 최종 점수 스케일링 계수 (sagitta/length 비율 -> 0~100 점수)
  // 실측 사진들로 튜닝 필요. 값이 클수록 같은 곡률에도 점수가 높게 나옴.
  SCORE_SCALE: 900,

  // 이 점수 미만이면 'pass', 이상이면 'retake'
  RETAKE_THRESHOLD: 40,
};

/* ============================ OpenCV 로딩 대기 ========================= */

var _cvReadyPromise = null;

/**
 * OpenCV.js(전역 cv)가 실제로 사용 가능한 상태가 될 때까지 기다립니다.
 *
 * OpenCV.js 배포 빌드마다 초기화 방식이 조금씩 다를 수 있어 아래 세 가지
 * 경우를 모두 처리합니다.
 *   1) cv 가 이미 준비된 경우 (cv.Mat 이 함수로 존재) -> 즉시 resolve.
 *   2) cv 자체가 Promise/thenable 인 경우 (일부 최신 빌드) -> 그 Promise가
 *      resolve 하는 실제 모듈 객체로 resolve.
 *   3) cv 가 아직 초기화 전 스텁 객체이고 cv.onRuntimeInitialized 콜백을
 *      지원하는 경우(전통적인 Emscripten 패턴) -> 콜백이 호출되는 시점에 resolve.
 * 세 경우 모두 폴링(50ms)과 함께 사용해 스크립트 로드 타이밍 이슈에 안전하게 대응합니다.
 * timeoutMs 안에 준비되지 않으면 reject 됩니다.
 *
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<any>} 실제로 사용 가능한 OpenCV 모듈 객체로 resolve 되는 Promise
 */
function waitForOpenCV(timeoutMs) {
  timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 20000;

  var isReady = function () {
    return typeof cv !== 'undefined' && cv && typeof cv.Mat === 'function';
  };

  if (isReady()) {
    return Promise.resolve(cv);
  }

  // 같은 대기 요청이 여러 번 들어와도 하나의 Promise를 재사용
  if (_cvReadyPromise) {
    return _cvReadyPromise;
  }

  _cvReadyPromise = new Promise(function (resolve, reject) {
    var settled = false;
    var intervalId = null;
    var timeoutId = null;
    var thenableHooked = false;
    var runtimeHooked = false;

    var finish = function (readyCv) {
      if (settled) return;
      settled = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      resolve(readyCv);
    };

    var fail = function (err) {
      if (settled) return;
      settled = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      // 실패 시 캐시를 비워서 다음 호출이 새로 재시도할 수 있게 함
      _cvReadyPromise = null;
      reject(err);
    };

    var tryHookThenable = function () {
      // 일부 최신 opencv.js 빌드는 전역 cv 자체가 Promise 로 제공됩니다.
      if (!thenableHooked && typeof cv !== 'undefined' && cv && typeof cv.then === 'function') {
        thenableHooked = true;
        cv.then(
          function (resolvedCv) {
            // 이후 다른 코드에서도 완성된 모듈을 참조할 수 있도록 전역도 갱신
            if (typeof window !== 'undefined') {
              window.cv = resolvedCv;
            }
            finish(resolvedCv);
          },
          function (err) {
            fail(err instanceof Error ? err : new Error('OpenCV.js 초기화 중 오류: ' + err));
          }
        );
        return true;
      }
      return false;
    };

    var tryHookRuntime = function () {
      // opencv.js 는 로드 직후 cv가 "초기화 전 스텁 객체"인 경우가 많고,
      // 이때 cv.onRuntimeInitialized 콜백이 준비 시점에 호출됩니다.
      if (
        !runtimeHooked &&
        typeof cv !== 'undefined' &&
        cv &&
        !isReady() &&
        typeof cv === 'object' &&
        'onRuntimeInitialized' in cv
      ) {
        runtimeHooked = true;
        var prev = cv.onRuntimeInitialized;
        cv.onRuntimeInitialized = function () {
          if (typeof prev === 'function') {
            try {
              prev();
            } catch (e) {
              /* 무시: 원래 콜백에서 에러가 나도 우리 로직은 계속 진행 */
            }
          }
          finish(cv);
        };
        return true;
      }
      return false;
    };

    tryHookThenable();
    tryHookRuntime();

    intervalId = setInterval(function () {
      if (isReady()) {
        finish(cv);
        return;
      }
      if (!tryHookThenable()) {
        tryHookRuntime();
      }
    }, 50);

    timeoutId = setTimeout(function () {
      fail(
        new Error(
          'OpenCV.js가 ' + timeoutMs + 'ms 안에 로드되지 않았습니다. ' +
          'CDN 스크립트 태그(<script src="https://docs.opencv.org/4.x/opencv.js">)가 ' +
          '올바르게 포함되어 있는지 확인하세요.'
        )
      );
    }, timeoutMs);
  });

  return _cvReadyPromise;
}

/** 현재 시점에 OpenCV.js 가 이미 준비되어 있는지 동기적으로 확인합니다. */
function isOpenCVReady() {
  return typeof cv !== 'undefined' && !!cv && typeof cv.Mat === 'function';
}

/* ============================ 내부 유틸 함수 ============================ */

function _angleDiffDeg(a, b) {
  var d = Math.abs(a - b);
  return Math.min(d, 180 - d);
}

function _safeDeleteAll(mats) {
  for (var i = 0; i < mats.length; i++) {
    var m = mats[i];
    try {
      if (m && typeof m.delete === 'function' && (typeof m.isDeleted !== 'function' || !m.isDeleted())) {
        m.delete();
      }
    } catch (e) {
      /* 정리 과정의 에러는 무시 */
    }
  }
}

/** CV_8UC1 그레이스케일 Mat의 밝기 중앙값(median)을 계산합니다 (자동 Canny 임계값용). */
function _computeMedianGray(cvRef, grayMat) {
  var srcVec = new cvRef.MatVector();
  var hist = new cvRef.Mat();
  var mask = new cvRef.Mat();
  try {
    srcVec.push_back(grayMat);
    cvRef.calcHist(srcVec, [0], mask, hist, [256], [0, 255]);
    var total = grayMat.rows * grayMat.cols;
    var cumulative = 0;
    var median = 128;
    for (var i = 0; i < 256; i++) {
      cumulative += hist.data32F[i];
      if (cumulative >= total / 2) {
        median = i;
        break;
      }
    }
    return median;
  } finally {
    srcVec.delete();
    hist.delete();
    mask.delete();
  }
}

/**
 * 밝기 중앙값 기반으로 초기 Canny 임계값을 잡은 뒤, 실제로 검출된 엣지
 * 픽셀의 비율을 보고 임계값을 자동으로 조정합니다.
 *
 * 순수 median 기반 자동 임계값(Canny_SIGMA)만 쓰면 벽이 밝고 대비가 낮은
 * 사진(흰 벽 등)에서 임계값이 지나치게 높게 잡혀 정작 필요한 모서리 엣지가
 * 거의 검출되지 않는 문제가 있어, 엣지 비율이 너무 낮으면 임계값을 낮추고
 * 너무 높으면(노이즈) 임계값을 높이는 재시도를 몇 차례 반복합니다.
 *
 * @returns {{edges: any, lower:number, upper:number, edgeRatio:number, attempts:number}}
 *          edges 는 호출자가 책임지고 delete() 해야 하는 새 Mat 입니다.
 */
function _autoCanny(cvRef, blurredGray, cfg) {
  var median = _computeMedianGray(cvRef, blurredGray);
  var sigma = cfg.CANNY_SIGMA;
  var lower = Math.max(10, Math.floor((1 - sigma) * median));
  var upper = Math.min(255, Math.ceil((1 + sigma) * median));
  if (upper - lower < 20) {
    lower = 50;
    upper = 150;
  }

  var totalPixels = blurredGray.rows * blurredGray.cols;
  var edges = new cvRef.Mat();
  var attempts = 0;
  var edgeRatio = 0;

  while (true) {
    cvRef.Canny(blurredGray, edges, lower, upper);
    var nonZero = cvRef.countNonZero(edges);
    edgeRatio = nonZero / totalPixels;

    var tooFew = edgeRatio < cfg.CANNY_MIN_EDGE_RATIO;
    var tooMany = edgeRatio > cfg.CANNY_MAX_EDGE_RATIO;

    if ((!tooFew && !tooMany) || attempts >= cfg.CANNY_MAX_ATTEMPTS) {
      break;
    }

    if (tooFew) {
      // 엣지가 너무 적음(고대비 임계값이 지나치게 높음) -> 임계값을 낮춰 재시도
      lower = Math.max(3, Math.floor(lower * 0.55));
      upper = Math.max(lower + 20, Math.floor(upper * 0.65));
    } else {
      // 엣지가 너무 많음(노이즈 과다) -> 임계값을 높여 재시도
      lower = Math.min(200, Math.floor(lower * 1.4) + 5);
      upper = Math.min(255, Math.floor(upper * 1.3) + 10);
    }
    attempts++;
  }

  return { edges: edges, lower: lower, upper: upper, edgeRatio: edgeRatio, attempts: attempts };
}

/**
 * HoughLinesP 결과에서 같은 물리적 모서리를 중복 검출한 직선들을 정리합니다.
 * 각도와 중점 위치가 비슷한 직선들 중 가장 긴 것만 대표로 남깁니다.
 */
function _dedupeSegments(segments, angleTolDeg, distTolPx) {
  var sorted = segments.slice().sort(function (a, b) {
    return b.length - a.length;
  });
  var kept = [];
  for (var i = 0; i < sorted.length; i++) {
    var seg = sorted[i];
    var midX = (seg.x1 + seg.x2) / 2;
    var midY = (seg.y1 + seg.y2) / 2;
    var isDup = false;
    for (var j = 0; j < kept.length; j++) {
      var k = kept[j];
      var kMidX = (k.x1 + k.x2) / 2;
      var kMidY = (k.y1 + k.y2) / 2;
      if (
        _angleDiffDeg(seg.angle, k.angle) <= angleTolDeg &&
        Math.hypot(midX - kMidX, midY - kMidY) <= distTolPx
      ) {
        isDup = true;
        break;
      }
    }
    if (!isDup) kept.push(seg);
  }
  return kept;
}

/**
 * 직선 후보(seg) 주변의 "실제 Canny 엣지 픽셀"들이 이상적인 직선에서
 * 얼마나 벗어나는지(잔차/곡률)를 계산합니다.
 *
 * 방법:
 *   1) seg의 두 끝점을 잇는 직선을 약간 연장한 구간을 따라 일정 간격으로 샘플링.
 *   2) 각 샘플 지점에서 직선에 수직인 방향으로 좁은 창(window)을 두고
 *      실제 엣지 픽셀(Canny 결과가 255인 픽셀)을 탐색.
 *   3) 찾은 엣지 픽셀의 "이상적인 직선으로부터의 수직 오프셋"을 잔차로 기록.
 *   4) 표본 오프셋들에서 선형 추세(끝점 선택 오차)를 제거한 뒤,
 *      남은 최대/RMS 편차를 곡률(bowing) 지표로 사용.
 */
function _computeLineResidual(edgesMat, seg, cfg) {
  var length = seg.length;
  if (length <= 0) return null;

  var dx = (seg.x2 - seg.x1) / length;
  var dy = (seg.y2 - seg.y1) / length;
  var nx = -dy;
  var ny = dx;

  var extend = cfg.RESIDUAL_EXTEND_RATIO * length;
  var halfWindow = cfg.RESIDUAL_HALF_WINDOW_PX;
  var step = cfg.RESIDUAL_SAMPLE_STEP_PX;

  var totalLen = length + 2 * extend;
  var numSamples = Math.max(6, Math.floor(totalLen / step));

  var width = edgesMat.cols;
  var height = edgesMat.rows;
  var data = edgesMat.data; // CV_8UC1 -> Uint8Array

  var samples = [];

  for (var s = 0; s <= numSamples; s++) {
    var t = -extend + (s / numSamples) * totalLen;
    var cx = seg.x1 + dx * t;
    var cy = seg.y1 + dy * t;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;

    var bestOffset = null;
    for (var w = -halfWindow; w <= halfWindow; w++) {
      var px = Math.round(cx + nx * w);
      var py = Math.round(cy + ny * w);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      if (data[py * width + px] > 0) {
        if (bestOffset === null || Math.abs(w) < Math.abs(bestOffset)) {
          bestOffset = w;
        }
      }
    }
    if (bestOffset !== null) {
      samples.push({ t: t, offset: bestOffset });
    }
  }

  if (samples.length < cfg.RESIDUAL_MIN_SAMPLES) {
    return null;
  }
  var coverage = samples.length / (numSamples + 1);
  if (coverage < cfg.RESIDUAL_MIN_COVERAGE) {
    return null;
  }

  // 선형 추세 제거 (최소자승법으로 offset ~= m*t + b 적합 후 잔차만 남김)
  var n = samples.length;
  var sumT = 0, sumO = 0, sumTT = 0, sumTO = 0;
  for (var i = 0; i < n; i++) {
    sumT += samples[i].t;
    sumO += samples[i].offset;
    sumTT += samples[i].t * samples[i].t;
    sumTO += samples[i].t * samples[i].offset;
  }
  var denom = n * sumTT - sumT * sumT;
  var m = denom !== 0 ? (n * sumTO - sumT * sumO) / denom : 0;
  var b = (sumO - m * sumT) / n;

  var maxAbsResidual = 0;
  var sumSq = 0;
  for (var j = 0; j < n; j++) {
    var fitted = m * samples[j].t + b;
    var detrended = samples[j].offset - fitted;
    var absVal = Math.abs(detrended);
    if (absVal > maxAbsResidual) maxAbsResidual = absVal;
    sumSq += detrended * detrended;
  }
  var rmsResidual = Math.sqrt(sumSq / n);

  return {
    maxAbsResidual: maxAbsResidual,
    rmsResidual: rmsResidual,
    sampleCount: n,
    coverage: coverage,
  };
}

/* ============================== 메인 함수 ============================== */

/**
 * 사진 한 장(캔버스)의 왜곡 점수를 계산합니다.
 *
 * @param {HTMLCanvasElement} canvas - 분석할 사진이 그려진 캔버스
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] - OpenCV.js 로딩 대기 타임아웃(ms)
 * @returns {Promise<{score:number, verdict:('pass'|'retake'), details:Object}>}
 *
 * details 필드 (디버깅/오버레이 표시용, 팀원이 무시해도 무방):
 *   - linesDetected: 왜곡 판단에 사용된 직선 후보 개수
 *   - confidence: 'high' | 'low' (신뢰할 만한 직선을 충분히 찾았는지)
 *   - lines: [{x1,y1,x2,y2,ratio}] - 원본 캔버스 좌표계 기준 직선들과
 *            각 직선의 정규화된 왜곡 비율(0에 가까울수록 곧은 직선)
 */
async function analyzeDistortion(canvas, options) {
  options = options || {};
  var cfg = DISTORTION_CONFIG;

  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('analyzeDistortion(canvas): HTMLCanvasElement가 필요합니다.');
  }
  if (!canvas.width || !canvas.height) {
    throw new Error('analyzeDistortion(canvas): 캔버스 크기가 0입니다. 이미지를 먼저 그려주세요.');
  }

  // OpenCV.js가 아직 로드되지 않았을 수 있으므로 준비될 때까지 안전하게 대기
  var cvRef = await waitForOpenCV(options.timeoutMs);

  var cleanup = [];
  try {
    var src = new cvRef.Mat();
    cleanup.push(src);
    cvRef.imread(canvas, src);
    // 위 방식이 안 먹는 빌드가 있을 수 있어 fallback 처리
    if (src.empty()) {
      src.delete();
      cleanup.pop();
      src = cvRef.imread(canvas);
      cleanup.push(src);
    }

    var origW = canvas.width;
    var origH = canvas.height;
    var scale = Math.min(1, cfg.MAX_PROCESS_DIM / Math.max(origW, origH));

    var proc = src;
    if (scale < 1) {
      var resized = new cvRef.Mat();
      cleanup.push(resized);
      cvRef.resize(
        src,
        resized,
        new cvRef.Size(Math.max(1, Math.round(origW * scale)), Math.max(1, Math.round(origH * scale))),
        0,
        0,
        cvRef.INTER_AREA
      );
      proc = resized;
    }

    var gray = new cvRef.Mat();
    cleanup.push(gray);
    cvRef.cvtColor(proc, gray, cvRef.COLOR_RGBA2GRAY);

    var blurred = new cvRef.Mat();
    cleanup.push(blurred);
    var k = cfg.BLUR_KSIZE % 2 === 0 ? cfg.BLUR_KSIZE + 1 : cfg.BLUR_KSIZE;
    cvRef.GaussianBlur(gray, blurred, new cvRef.Size(k, k), 0, 0, cvRef.BORDER_DEFAULT);

    // --- 1) Canny 엣지 검출 (밝기 중앙값 기반 자동 임계값 + 엣지 비율 기반 재시도) ---
    var cannyResult = _autoCanny(cvRef, blurred, cfg);
    var edges = cannyResult.edges;
    var lower = cannyResult.lower;
    var upper = cannyResult.upper;
    cleanup.push(edges);

    // --- 2) HoughLinesP로 직선 후보 검출 ---
    var procW = proc.cols;
    var procH = proc.rows;
    var diag = Math.hypot(procW, procH);
    var minLineLength = Math.max(20, diag * cfg.HOUGH_MIN_LINE_LENGTH_RATIO);
    var maxLineGap = Math.max(8, diag * cfg.HOUGH_MAX_LINE_GAP_RATIO);

    var linesMat = new cvRef.Mat();
    cleanup.push(linesMat);
    cvRef.HoughLinesP(
      edges,
      linesMat,
      1,
      Math.PI / 180,
      cfg.HOUGH_THRESHOLD,
      minLineLength,
      maxLineGap
    );

    // 주의: HoughLinesP 결과 Mat의 레이아웃은 OpenCV.js 빌드에 따라
    // (N행 x 1열) 또는 (1행 x N열)로 다를 수 있어(둘 다 CV_32SC4),
    // rows만 믿지 않고 rows*cols를 검출된 직선 개수로 사용합니다.
    var houghLineCount = linesMat.rows * linesMat.cols;
    var rawSegments = [];
    for (var i = 0; i < houghLineCount; i++) {
      var x1 = linesMat.data32S[i * 4];
      var y1 = linesMat.data32S[i * 4 + 1];
      var x2 = linesMat.data32S[i * 4 + 2];
      var y2 = linesMat.data32S[i * 4 + 3];
      var len = Math.hypot(x2 - x1, y2 - y1);
      if (len < minLineLength) continue;
      var angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (angle < 0) angle += 180;
      rawSegments.push({ x1: x1, y1: y1, x2: x2, y2: y2, length: len, angle: angle });
    }

    // 중복(같은 모서리를 여러 번 검출한 것) 정리 후 상위 N개만 사용
    var distTolPx = Math.max(10, diag * cfg.DEDUP_DIST_TOL_RATIO);
    var dedupedSegments = _dedupeSegments(rawSegments, cfg.DEDUP_ANGLE_TOL_DEG, distTolPx);
    var candidateSegments = dedupedSegments
      .sort(function (a, b) {
        return b.length - a.length;
      })
      .slice(0, cfg.MAX_CANDIDATE_LINES);

    // --- 3) 각 직선 후보 구간에서 실제 엣지 픽셀의 잔차(곡률) 계산 ---
    var totalWeight = 0;
    var weightedRatioSum = 0;
    var maxRatio = 0;
    var lineResults = [];
    var invScale = scale > 0 ? 1 / scale : 1;

    for (var s = 0; s < candidateSegments.length; s++) {
      var seg = candidateSegments[s];
      var residual = _computeLineResidual(edges, seg, cfg);
      if (!residual) continue;

      var ratio = residual.maxAbsResidual / seg.length;
      weightedRatioSum += ratio * seg.length;
      totalWeight += seg.length;
      if (ratio > maxRatio) maxRatio = ratio;

      lineResults.push({
        x1: seg.x1 * invScale,
        y1: seg.y1 * invScale,
        x2: seg.x2 * invScale,
        y2: seg.y2 * invScale,
        ratio: ratio,
        maxAbsResidual: residual.maxAbsResidual,
        rmsResidual: residual.rmsResidual,
        coverage: residual.coverage,
      });
    }

    // --- 4) 0~100 사이의 왜곡 점수로 정규화 ---
    var rawScore = 0;
    var confidence = 'high';
    if (totalWeight === 0 || lineResults.length === 0) {
      // 신뢰할 만한 직선을 찾지 못한 경우: 판단 근거가 부족하므로
      // 왜곡이 없다고 단정하지 않고 낮은 신뢰도로 표시합니다.
      rawScore = 0;
      confidence = 'low';
    } else {
      var weightedAvgRatio = weightedRatioSum / totalWeight;
      rawScore = 0.6 * weightedAvgRatio + 0.4 * maxRatio;
    }

    var score = Math.min(100, Math.max(0, rawScore * cfg.SCORE_SCALE));
    score = Math.round(score * 10) / 10;
    var verdict = score < cfg.RETAKE_THRESHOLD ? 'pass' : 'retake';

    return {
      score: score,
      verdict: verdict,
      details: {
        linesDetected: lineResults.length,
        confidence: confidence,
        cannyThresholds: { lower: lower, upper: upper },
        edgeRatio: cannyResult.edgeRatio,
        rawSegmentCount: rawSegments.length,
        candidateSegmentCount: candidateSegments.length,
        lines: lineResults,
      },
    };
  } finally {
    _safeDeleteAll(cleanup);
  }
}

// 명시적으로 전역에 노출 (module 태그 없이 <script>로 로드되므로 사실상
// 이미 전역이지만, 방어적으로 한 번 더 지정합니다.)
if (typeof window !== 'undefined') {
  window.analyzeDistortion = analyzeDistortion;
  window.waitForOpenCV = waitForOpenCV;
  window.isOpenCVReady = isOpenCVReady;
  window.DISTORTION_CONFIG = DISTORTION_CONFIG;
}