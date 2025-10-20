// 基本設定
let scene, camera, renderer;
let reticle; // 置くためのレティクル（位置マーカー）
let model;   // 落書きから生成した簡易モデル
const imageUpload = document.getElementById('imageUpload');
const startARBtn = document.getElementById('startAR');
const errorMsg = document.getElementById('errorMsg');

let uploadedImage = null;

imageUpload.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        uploadedImage = null;
        startARBtn.disabled = true;
        return;
    }
    const imgURL = URL.createObjectURL(file);
    uploadedImage = new Image();
    uploadedImage.onload = () => {
        console.log('画像読み込み完了:', uploadedImage.width, uploadedImage.height);
        // 今回は読み込んだ画像をモデル生成のトリガーとする
        startARBtn.disabled = false;
    };
    uploadedImage.src = imgURL;
});

startARBtn.addEventListener('click', () => {
    if (!uploadedImage) {
        errorMsg.textContent = '画像をアップロードしてください。';
        return;
    }
    initAR();
});

// AR 初期化
async function initAR() {
    // レンダラー作成
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // シーンとカメラ
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // ライト
    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
    light.position.set(0.5, 1, 0.25);
    scene.add(light);

    // レティクル（簡易：平面上に配置用マーカー）
    const geometry = new THREE.RingGeometry(0.1, 0.15, 32).rotateX(- Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    reticle = new THREE.Mesh(geometry, material);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    // モデル生成：今回はアップロード画像を元に簡易ボックスとして配置
    // 実運用では輪郭抽出→骨格割り→モデル化処理を追加
    model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0xff0000 })
    );
    model.visible = false;
    scene.add(model);

    // WebXR セッション開始
    document.body.appendChild(ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] }));
    renderer.xr.addEventListener('sessionstart', () => {
        console.log('ARセッション開始');
    });

    const session = renderer.xr.getSession();
    if (!session) {
        // まだボタン押されてない可能性がある
        renderer.xr.setSession(await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'] }));
    }

    const referenceSpace = await renderer.xr.getReferenceSpace(); // local reference space
    const viewerSpace = await renderer.xr.getSession().requestReferenceSpace('viewer');
    const hitTestSource = await renderer.xr.getSession().requestHitTestSource({ space: viewerSpace });

    renderer.setAnimationLoop((time, frame) => {
        if (frame) {
            const viewerPose = frame.getViewerPose(referenceSpace);
            if (viewerPose) {
                const hitTestResults = frame.getHitTestResults(hitTestSource);
                if (hitTestResults.length > 0) {
                    const hit = hitTestResults[0];
                    const hitPose = hit.getPose(referenceSpace);
                    reticle.visible = true;
                    reticle.matrix.fromArray(hitPose.transform.matrix);
                } else {
                    reticle.visible = false;
                }
            }
        }
        renderer.render(scene, camera);
    });

    // タップ操作：レティクル位置にモデル配置
    window.addEventListener('click', (ev) => {
        if (reticle.visible && model) {
            model.visible = true;
            model.position.setFromMatrixPosition(reticle.matrix);
            model.scale.set(0.2, 0.2, 0.2);
            // シンプルなアニメーション
            model.rotation.y = Math.random() * Math.PI * 2;
        }
    });
    // 上記の app.js に続けて追加

    function onOpenCvReady() {
        console.log('OpenCV.js is ready');
    }

    // 画像アップロード後、輪郭抽出＋骨格割り付けを試みる
    async function processDrawingImage(imageElement) {
        // Canvas に描画して画像データ取得
        const canvas = document.createElement('canvas');
        canvas.width = imageElement.width;
        canvas.height = imageElement.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageElement, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // OpenCV.js マットに変換
        let src = cv.matFromImageData(imageData);
        let gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

        // 二値化（適応閾値または固定閾値）
        let binary = new cv.Mat();
        cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

        // 輪郭検出
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        console.log('Contours found: ', contours.size());

        // 最大輪郭（面積最大）を選定
        let maxArea = 0;
        let maxContour = null;
        for (let i = 0; i < contours.size(); i++) {
            let cnt = contours.get(i);
            let area = cv.contourArea(cnt, false);
            if (area > maxArea) {
                maxArea = area;
                maxContour = cnt;
            }
        }

        if (maxContour) {
            // 輪郭のバウンディングボックスを取得
            let rect = cv.boundingRect(maxContour);
            console.log('Bounding rect:', rect);

            // 骨格割り付けの簡易ロジック：
            // 頭＝バウンディングボックスの上部 20%、胴体＝中央 40%、脚＝下部 40%
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

            // Canvas 上に検出結果（デバッグ用）を描画
            ctx.strokeStyle = 'red';
            ctx.lineWidth = 3;
            ctx.strokeRect(headBox.x, headBox.y, headBox.width, headBox.height);
            ctx.strokeStyle = 'blue';
            ctx.strokeRect(bodyBox.x, bodyBox.y, bodyBox.width, bodyBox.height);
            ctx.strokeStyle = 'green';
            ctx.strokeRect(legsBox.x, legsBox.y, legsBox.width, legsBox.height);

            // この骨格情報を元に three.js モデル構成へ反映（例：頭・胴体・脚それぞれ Box ジオメトリを配置）
            createSkeletonModel(headBox, bodyBox, legsBox, canvas.width, canvas.height);
        }

        // メモリ解放
        src.delete();
        gray.delete();
        binary.delete();
        contours.delete();
        hierarchy.delete();
    }

    // 骨格モデル生成（簡易版）
    function createSkeletonModel(headBox, bodyBox, legsBox, imgW, imgH) {
        // three.js 空間上にモデル生成
        // 規定サイズをワールド座標系に変換（ここでは幅1単位を画像幅にマップ）
        const scale = 0.001; // 調整値
        const headGeom = new THREE.BoxGeometry(headBox.width * scale, headBox.height * scale, 0.1);
        const bodyGeom = new THREE.BoxGeometry(bodyBox.width * scale, bodyBox.height * scale, 0.1);
        const legsGeom = new THREE.BoxGeometry(legsBox.width * scale, legsBox.height * scale, 0.1);

        const headMat = new THREE.MeshStandardMaterial({ color: 0xffff00 });
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff00ff });
        const legsMat = new THREE.MeshStandardMaterial({ color: 0x00ffff });

        const headMesh = new THREE.Mesh(headGeom, headMat);
        const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
        const legsMesh = new THREE.Mesh(legsGeom, legsMat);

        // 位置調整（カメラから見て前方に配置・Y軸上下を反転調整など）
        headMesh.position.set(0, (bodyBox.height * scale) / 2 + (headBox.height * scale) / 2, 0);
        bodyMesh.position.set(0, 0, 0);
        legsMesh.position.set(0, -(bodyBox.height * scale) / 2 - (legsBox.height * scale) / 2, 0);

        // 既存モデルをクリアして新規モデルを追加
        if (model) {
            scene.remove(model);
        }
        const group = new THREE.Group();
        group.add(headMesh);
        group.add(bodyMesh);
        group.add(legsMesh);

        model = group;
        scene.add(model);
        model.visible = false; // 配置時まで非表示
    }

}
