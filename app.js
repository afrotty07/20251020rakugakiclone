// app.js（ES Modules）
import * as THREE from 'https://unpkg.com/three@0.150.0/build/three.module.js';

// ------------------------------------------------------------
// DOM 要素
// ------------------------------------------------------------
const imageUpload = document.getElementById('imageUpload');
const startARBtn = document.getElementById('startAR');
const errorMsgEl = document.getElementById('errorMsg');
const cvStatusEl = document.getElementById('cvStatus');

// ------------------------------------------------------------
// three.js 基本セット
// ------------------------------------------------------------
let scene, camera, renderer;
let reticle;   // 平面ヒット位置を示すレティクル
let model;     // 生成済み 3D モデル（OpenCV結果または簡易Box）
let xrSession; // XRSession（明示保持）

// ------------------------------------------------------------
// 画像バッファ
// ------------------------------------------------------------
let uploadedImage = null;

// ------------------------------------------------------------
// OpenCV 初期化待ち（読み込めたら true）
// ------------------------------------------------------------
let cvReady = false;

async function waitForOpenCVReady() {
    // OpenCV.js が読み込まれ `cv` が定義されたら true を返す。
    // onRuntimeInitialized の有無に対応。
    return new Promise((resolve) => {
        const tick = () => {
            if (typeof cv !== 'undefined' && cv && cv.Mat) {
                resolve(true);
            } else {
                setTimeout(tick, 50);
            }
        };
        // onRuntimeInitialized を使えるケースにも対応
        if (typeof cv !== 'undefined') {
            if (cv && cv.Mat) {
                resolve(true);
            } else {
                cv['onRuntimeInitialized'] = () => resolve(true);
            }
        } else {
            tick();
        }
    });
}

waitForOpenCVReady().then(() => {
    cvReady = true;
    if (cvStatusEl) cvStatusEl.textContent = 'OpenCV: ready';
    console.log('OpenCV.js is ready');
}).catch(() => {
    cvReady = false;
    if (cvStatusEl) cvStatusEl.textContent = 'OpenCV: not available';
});

// ------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------
function showError(message) {
    errorMsgEl.textContent = message;
    errorMsgEl.classList.add('show');
}
function clearError() {
    errorMsgEl.textContent = '';
    errorMsgEl.classList.remove('show');
}

// ------------------------------------------------------------
// 画像アップロード：読み込み完了で StartAR を有効化
// ------------------------------------------------------------
imageUpload.addEventListener('change', (event) => {
    clearError();
    const file = event.target.files && event.target.files[0];
    if (!file) {
        uploadedImage = null;
        startARBtn.disabled = true;
        return;
    }
    const imgURL = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        uploadedImage = img;
        console.log('画像読み込み完了:', img.width, img.height);
        startARBtn.disabled = false; // ← ここで必ず有効化
    };
    img.onerror = () => {
        uploadedImage = null;
        startARBtn.disabled = true;
        showError('画像の読み込みに失敗しました。別のファイルでお試しください。');
    };
    img.src = imgURL;
});

// ------------------------------------------------------------
// Start AR
// ------------------------------------------------------------
startARBtn.addEventListener('click', async () => {
    clearError();
    if (!uploadedImage) {
        showError('画像をアップロードしてください。');
        return;
    }
    // WebXR サポート確認
    if (!navigator.xr || !navigator.xr.isSessionSupported) {
        showError('この端末/ブラウザは WebXR に対応していません。');
        return;
    }
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (!supported) {
        showError('この端末/ブラウザは「immersive-ar」に対応していません。');
        return;
    }

    try {
        await initAR(); // 初期化（three.js / hit-test 等）
    } catch (e) {
        console.error(e);
        showError('AR の初期化に失敗しました。HTTPS や対応端末をご確認ください。');
    }
});

// ------------------------------------------------------------
// AR 初期化
// ------------------------------------------------------------
async function initAR() {
    // three.js renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // シーン / カメラ
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // ライト
    const hemi = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.0);
    hemi.position.set(0.5, 1, 0.25);
    scene.add(hemi);

    // レティクル（床ヒット表示）
    const ring = new THREE.RingGeometry(0.08, 0.11, 32);
    ring.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
    reticle = new THREE.Mesh(ring, ringMat);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    // まずは簡易モデル（OpenCV結果があれば後で差し替え）
    model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.6 })
    );
    model.visible = false;
    scene.add(model);

    // 画像から骨格風パーツを作る（OpenCV が使える場合）
    if (cvReady) {
        try {
            const parts = await processDrawingImage(uploadedImage);
            if (parts) {
                replaceWithSkeleton(parts);
            }
        } catch (e) {
            console.warn('OpenCV 処理エラー:', e);
            // 失敗しても簡易 Box で継続
        }
    }

    // XR セッション開始（ユーザー操作の直後なのでジェスチャ要件を満たす）
    xrSession = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'] // 平面推定による配置
    });
    renderer.xr.setSession(xrSession);

    const refSpace = await renderer.xr.getReferenceSpace();    // 'local' 既定
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    const hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

    // レンダーループ
    renderer.setAnimationLoop((time, frame) => {
        if (frame) {
            const results = frame.getHitTestResults(hitTestSource);
            if (results && results.length > 0) {
                const pose = results[0].getPose(refSpace);
                if (pose) {
                    reticle.visible = true;
                    reticle.matrix.fromArray(pose.transform.matrix);
                }
            } else {
                reticle.visible = false;
            }
        }
        renderer.render(scene, camera);
    });

    // タップでレティクル位置にモデルを配置
    window.addEventListener('click', () => {
        if (reticle.visible && model) {
            model.visible = true;
            model.position.setFromMatrixPosition(reticle.matrix);
            model.rotation.y = Math.random() * Math.PI * 2;
            // 簡易ポップ（小さく→元サイズ）
            model.scale.set(0.001, 0.001, 0.001);
            popIn(model);
        }
    });

    // リサイズ対応
    window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
    if (!renderer || !camera) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ------------------------------------------------------------
// 簡易アニメ（ポップイン）
function popIn(mesh) {
    const target = { s: 1 };
    const start = performance.now();
    const dur = 220; // ms
    function step(t) {
        const e = Math.min(1, (t - start) / dur);
        const ease = 1 - Math.pow(1 - e, 3);
        const s = 0.001 + (target.s - 0.001) * ease;
        mesh.scale.set(s, s, s);
        if (e < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// ------------------------------------------------------------
// OpenCV：輪郭抽出 → 最大外枠 → バウンディング分割で簡易「頭/胴/脚」
// ------------------------------------------------------------
async function processDrawingImage(imageElement) {
    // Canvasに描画して ImageData を得る
    const canvas = document.createElement('canvas');
    canvas.width = imageElement.width;
    canvas.height = imageElement.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // OpenCV Mat へ
    let src = cv.matFromImageData(imageData);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 前処理（ノイズ低減）
    let blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

    // 二値化（背景→白、線→黒 にするため INV + OTSU）
    let binary = new cv.Mat();
    cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    // モルフォロジーで線の途切れを少し補う（任意）
    let kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);

    // 輪郭抽出（最大外枠）
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let maxContour = null;
    for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const a = cv.contourArea(c, false);
        if (a > maxArea) {
            maxArea = a;
            maxContour = c;
        }
    }

    let parts = null;
    if (maxContour) {
        const rect = cv.boundingRect(maxContour);
        // 非常に単純化：上20%を「頭」、中央40%を「胴」、下40%を「脚」
        const headBox = {
            x: rect.x + rect.width * 0.25,
            y: rect.y,
            width: rect.width * 0.5,
            height: rect.height * 0.2
        };
        const bodyBox = {
            x: rect.x + rect.width * 0.2,
            y: rect.y + rect.height * 0.2,
            width: rect.width * 0.6,
            height: rect.height * 0.4
        };
        const legsBox = {
            x: rect.x + rect.width * 0.2,
            y: rect.y + rect.height * 0.6,
            width: rect.width * 0.6,
            height: rect.height * 0.4
        };

        parts = { headBox, bodyBox, legsBox, imgW: canvas.width, imgH: canvas.height };
    }

    // メモリ解放
    src.delete(); gray.delete(); blur.delete(); binary.delete();
    kernel.delete(); contours.delete(); hierarchy.delete();

    return parts;
}

// ------------------------------------------------------------
// three.js モデルを「頭/胴/脚」構成に差し替える
// ------------------------------------------------------------
function replaceWithSkeleton(parts) {
    const { headBox, bodyBox, legsBox } = parts;

    const scale = 0.001; // 画像ピクセル → ワールド座標の縮尺

    const head = new THREE.Mesh(
        new THREE.BoxGeometry(headBox.width * scale, headBox.height * scale, 0.08),
        new THREE.MeshStandardMaterial({ color: 0xffe066, metalness: 0.05, roughness: 0.7 })
    );
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(bodyBox.width * scale, bodyBox.height * scale, 0.1),
        new THREE.MeshStandardMaterial({ color: 0x66d9e8, metalness: 0.05, roughness: 0.7 })
    );
    const legs = new THREE.Mesh(
        new THREE.BoxGeometry(legsBox.width * scale, legsBox.height * scale, 0.12),
        new THREE.MeshStandardMaterial({ color: 0xb197fc, metalness: 0.05, roughness: 0.7 })
    );

    // 簡易的に「胴」を原点にし、そこから上下に配置
    head.position.set(0, (bodyBox.height * scale) / 2 + (headBox.height * scale) / 2, 0);
    body.position.set(0, 0, 0);
    legs.position.set(0, -(bodyBox.height * scale) / 2 - (legsBox.height * scale) / 2, 0);

    const group = new THREE.Group();
    group.add(head);
    group.add(body);
    group.add(legs);

    if (model) scene.remove(model);
    model = group;
    scene.add(model);
    model.visible = false; // 置くまでは非表示
}
