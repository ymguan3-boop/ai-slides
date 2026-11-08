(function () {
  "use strict";

  const DATA = window.WUJIE_MODEL_DATA;
  const FLOW = window.WujieFlowEvent;
  const REGIONAL = window.WUJIE_REGIONAL_DATA;
  const DEDUP = window.WUJIE_BUILDING_DEDUP || { removedIds: [] };
  const SUPPRESSED_BUILDING_IDS = new Set(DEDUP.removedIds || []);
  const canvas = document.getElementById("scene-canvas");
  const errorCard = document.getElementById("webgl-error");
  const loading = document.getElementById("loading");
  const app = document.getElementById("app");

  if (!window.THREE || !DATA || !REGIONAL || !FLOW || !window.WujieBuildingCensus || !DATA.reportImpactScope || !supportsWebGL()) {
    loading.classList.add("ready");
    errorCard.hidden = false;
    errorCard.querySelector("p").textContent = !DATA?.reportImpactScope
      ? "模型資料版本不完整，請重新載入；若仍失敗，請通知製作者更新網站資料。"
      : "3D元件或資料未完整載入，請重新載入或確認瀏覽器支援WebGL。";
    return;
  }
  const contextBuildings = (REGIONAL.contextBuildings || []).filter((building) => !SUPPRESSED_BUILDING_IDS.has(building.id));

  const DATUM = 2.0;
  const CENTER_E = REGIONAL.center.e;
  const CENTER_N = REGIONAL.center.n;
  const CELL = REGIONAL.terrain.cellSizeM;
  const HYDRO_ARRIVAL = REGIONAL.hydrography?.arrivalDistanceCellsSouthToNorth || [];
  const HYDRO_MAX_ARRIVAL = HYDRO_ARRIVAL.reduce((maximum, row) => row.reduce((inner, value) => value >= 0 ? Math.max(inner, value) : inner, maximum), 0);
  const GATE_E = REGIONAL.reviewExtent.gatePoint.e;
  const GATE_N = REGIONAL.reviewExtent.gatePoint.n;
  const GATE_X = GATE_E - CENTER_E;
  const GATE_Z = CENTER_N - GATE_N;
  const riskColors = {
    "無": new THREE.Color("#8da4a3"),
    "低": new THREE.Color("#ff6b57"),
    "中": new THREE.Color("#ff321f"),
    "高": new THREE.Color("#ed0000"),
    "極高": new THREE.Color("#b50000"),
  };
  const requestedWaterOffset = Number(new URLSearchParams(window.location.search).get("water"));
  const initialWaterOffset = Number.isFinite(requestedWaterOffset)
    ? Math.max(-0.5, Math.min(0.5, requestedWaterOffset)) : 0;

  const state = {
    scenarioId: "OPERATION2020_Q10_750",
    analysisYearId: "BASE_2020",
    constructionState: "after",
    waterOffset: 0,
    displayFlowCms: 750,
    eventHours: Infinity,
    eventActive: false,
    verticalScale: 1,
    basemapSource: "nlsc",
    renderMode: "white",
    buildingSource: "official",
    analysisScope: "regional",
    labels: true,
    labelCategories: { building: true, road: true, engineering: true, river: true, place: true },
    selected: null,
    freeExplore: false,
    cameraTransition: null,
    cameraView: "regional",
    fixedCameraView: "regional",
    currentRiskCount: 0,
    currentRegionalRiskCount: 0,
    currentDetailRiskCount: 0,
    currentMaxDepth: 0,
    currentComparison: null,
    wraLayerId: "500mm_24h",
    wraAssessmentReady: false,
    wraAssessmentById: new Map(),
    wraLayerCatalog: [],
    floodAnimation: { playing: false, paused: false, start: 0, from: -0.5, duration: 10000, lastFrame: 0 },
  };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dbe6e8");
  scene.fog = new THREE.FogExp2("#dbe6e8", 0.000025);

  const camera = new THREE.PerspectiveCamera(47, window.innerWidth / window.innerHeight, 0.5, 45000);
  camera.position.set(GATE_X + 2200, 14000, GATE_Z + 15000);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.screenSpacePanning = false;
  controls.minDistance = 70;
  controls.maxDistance = 32000;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.target.set(GATE_X, 4, GATE_Z);
  const defaultRightMouseAction = controls.mouseButtons.RIGHT;
  // Navigation cancels only the camera tween, never the independent flood clock.
  controls.addEventListener('start', () => { state.cameraTransition = null; });

  const worldRoot = new THREE.Group();
  worldRoot.name = "wujie-world";
  worldRoot.scale.y = state.verticalScale;
  scene.add(worldRoot);

  const hemisphere = new THREE.HemisphereLight("#f7fbff", "#68766c", 1.22);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight("#fff8e8", 1.65);
  sun.position.set(-1600, 3200, 1800);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9000;
  sun.shadow.camera.right = 9000;
  sun.shadow.camera.top = 9000;
  sun.shadow.camera.bottom = -9000;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 6000;
  scene.add(sun);

  const terrainGroup = new THREE.Group();
  const cadastralGroup = new THREE.Group();
  const buildingReferenceGroup = new THREE.Group();
  const engineeringDrawingGroup = new THREE.Group();
  const reportBoundaryGroup = new THREE.Group();
  const riverQaGroup = new THREE.Group();
  const infrastructureGroup = new THREE.Group();
  const contextBuildingGroup = new THREE.Group();
  const buildingGroup = new THREE.Group();
  const riverGroup = new THREE.Group();
  riverGroup.visible = false;
  let floodGroup = new THREE.Group();
  worldRoot.add(terrainGroup, cadastralGroup, buildingReferenceGroup, engineeringDrawingGroup, reportBoundaryGroup, riverQaGroup, contextBuildingGroup, infrastructureGroup, buildingGroup, riverGroup, floodGroup);

  const clickableMeshes = [];
  const buildingObjects = new Map();
  const parcelObjects = new Map();
  const engineeringObjects = new Map();
  const reportBoundaryObjects = new Map();
  const labelAnchors = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDown = null;
  let hoverRaycastFrame = null;
  let pendingHoverPoint = null;
  let terrainMesh;
  let wireframeMesh;
  const basemapTextures = { nlsc: null, emap5: null, dtm: null };
  const basemapLoadState = { nlsc: "pending", emap5: "pending", dtm: "ready" };
  let riverMesh = null;
  let regionalBuildingMesh = null;
  let regionalRiskOverlayMesh = null;
  const regionalBuildingMatrices = [];
  let selectionHelper = null;
  let activeFloodCells = new Set();
  let activeFloodCellData = new Map();
  const comparisonRiskCache = new Map();
  let officialBuildings = null;
  let rainRipples = null;
  const buildingCensus = new window.WujieBuildingCensus(REGIONAL.terrain.extent, {cellSizeM:CELL, xmin:REGIONAL.terrain.extent.xmin, ymin:REGIONAL.terrain.extent.ymin});
  const censusRiskCache = new WeakMap();
  const censusStorageKey='wujie-available-census-v15-'+(window.WUJIE_OFFLINE_CONTEXT?.regionalDataSha256||'63344d195d6e6604');
  let censusCaptureTimer=null, censusStorageWarning='', censusRestorePending=true;
  const calculationScopeCache=new Map();
  const calculationPopulationCache=new Map();
  try { const saved=localStorage.getItem(censusStorageKey);if(saved)buildingCensus.restore(JSON.parse(saved)); }
  catch(error){censusStorageWarning='先前清冊未還原：'+error.message;}
  storedCensus('get').then(saved=>{if(saved)buildingCensus.restore(saved);}).catch(error=>{censusStorageWarning='瀏覽器清冊資料庫未還原：'+error.message;}).finally(()=>{censusRestorePending=false;comparisonRiskCache.clear();updateScenarioPresentation();});

  createTerrain();
  createReferenceOverlays();
  createSceneFrame();
  createReportBoundaries();
  createRiver();
  createRiverQaOverlay();
  if(window.WujieRainRipples) rainRipples = new window.WujieRainRipples(THREE,worldRoot,rainSurfaceAt);
  canvas.dataset.rippleModule=rainRipples?'ready':'missing';
  createDikes();
  createGates();
  applyConstructionStateVisibility();
  createCadastralReference();
  createRegionalBuildings();
  createBuildings();
  createOfficialBuildings();
  createContextMarkers();
  createRegionalLabels();
  createScenarioControls();
  wireUi();
  loadBasemap();
  document.getElementById("water-slider").value = initialWaterOffset.toFixed(2);
  document.getElementById("render-mode").value = "white";
  applyRenderMode();
  selectScenario("OPERATION2020_Q10_750", false, false);
  setCameraView("regional", false);
  window.requestAnimationFrame(updateResponsiveQa);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(animate);
  document.getElementById("app").dataset.sceneReady = "true";

  function supportsWebGL() {
    try {
      const probe = document.createElement("canvas");
      return !!(probe.getContext("webgl2") || probe.getContext("webgl") || probe.getContext("experimental-webgl"));
    } catch (error) {
      return false;
    }
  }

  async function loadWraAssessment() {
    try {
      // 公開網頁使用壓縮執行檔，完整 JSON 仍保留於 data/ 供查核與再分析。
      const response = await fetch("data/wra_flood_potential_building_assessment.min.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.wraLayerCatalog = payload.layers || [];
      state.wraAssessmentById = new Map((payload.buildings || []).map((row) => [row.建物識別碼, row]));
      state.wraAssessmentReady = true;
      const select = document.getElementById("wra-layer");
      if (select) {
        select.innerHTML = state.wraLayerCatalog.map((layer) => `<option value="${escapeHtml(layer.id)}">${escapeHtml(layer.durationHours)}小時／${escapeHtml(layer.rainfallMm)}mm</option>`).join("");
        select.value = state.wraLayerCatalog.some((layer) => layer.id === state.wraLayerId) ? state.wraLayerId : state.wraLayerCatalog[state.wraLayerCatalog.length - 1]?.id;
        state.wraLayerId = select.value || state.wraLayerId;
      }
      const note = document.getElementById("wra-layer-note");
      if (note) note.textContent = `已載入${state.wraLayerCatalog.length}組水利署公開SHP（官方建置2019／平台上架2022）；KML為AOI裁切衍生檔。`;
      updateScenarioPresentation();
    } catch (error) {
      state.wraAssessmentReady = false;
      const note = document.getElementById("wra-layer-note");
      if (note) note.textContent = "水利署圖層評估檔尚未載入；不影響本案靜態水位篩檢。請以HTTP伺服器開啟模型後重試。";
      window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, { wraAssessmentError: String(error) });
    }
  }

  function wraRecord(building) {
    return state.wraAssessmentById.get(building?.id) || null;
  }

  function wraLayerRecord(building, layerId = state.wraLayerId) {
    return wraRecord(building)?.水利署潛勢參考?.[layerId] || null;
  }

  function hasWraPotential(building, layerId = state.wraLayerId) {
    return Number(wraLayerRecord(building, layerId)?.重疊面積平方公尺 || 0) > 0;
  }

  function wraSummaryLabel(building, layerId = state.wraLayerId) {
    if (!state.wraAssessmentReady) return "載入中";
    const hit = wraLayerRecord(building, layerId);
    if (!hit || !(Number(hit.重疊面積平方公尺) > 0)) return "本層未重疊";
    return `重疊${Number(hit.重疊面積平方公尺).toFixed(1)}m²／級距${hit.淹水深度級距 || "未註明"}`;
  }

  function localPosition(e, n, elev) {
    return new THREE.Vector3(e - CENTER_E, elev - DATUM, CENTER_N - n);
  }

  function createTerrain() {
    const terrain = REGIONAL.terrain;
    const rows = terrain.rows;
    const cols = terrain.cols;
    const vertices = new Float32Array(rows * cols * 3);
    const uvs = new Float32Array(rows * cols * 2);
    const indices = [];
    let vi = 0;
    let ui = 0;
    for (let row = 0; row < rows; row += 1) {
      const n = terrain.extent.ymin + row * CELL;
      for (let col = 0; col < cols; col += 1) {
        const e = terrain.extent.xmin + col * CELL;
        const rawZ = terrain.heightsSouthToNorth[row][col];
        // The open 20 m DTM has no dependable bathymetry. For display only,
        // lower vertices inside the drawing-derived river polygon to EL 0.60 m.
        const z = pointInPolygon(e, n, DATA.infrastructure.riverPolygon) ? Math.min(rawZ, 0.60) : rawZ;
        vertices[vi++] = e - CENTER_E;
        vertices[vi++] = z - DATUM;
        vertices[vi++] = CENTER_N - n;
        uvs[ui++] = col / (cols - 1);
        uvs[ui++] = row / (rows - 1);
      }
    }
    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        const a = row * cols + col;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({
      color: "#d6d6d2",
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    terrainMesh = new THREE.Mesh(geometry, material);
    terrainMesh.name = "MOI-20m-DTM";
    terrainMesh.receiveShadow = true;
    terrainGroup.add(terrainMesh);

    const wireMaterial = new THREE.MeshBasicMaterial({ color: "#55d6d1", wireframe: true, transparent: true, opacity: 0.18 });
    wireframeMesh = new THREE.Mesh(geometry.clone(), wireMaterial);
    wireframeMesh.position.y = 0.035;
    wireframeMesh.visible = false;
    terrainGroup.add(wireframeMesh);
  }

  function createSceneFrame() {
    const width = REGIONAL.extent.xmax - REGIONAL.extent.xmin;
    const height = REGIONAL.extent.ymax - REGIONAL.extent.ymin;
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, 0.3, height)),
      new THREE.LineBasicMaterial({ color: "#71d9d4", transparent: true, opacity: 0.3 })
    );
    frame.position.y = -0.08;
    terrainGroup.add(frame);
  }

  function createReportBoundaries() {
    (REGIONAL.reportBoundaries || []).forEach((boundary) => {
      const points = boundary.points.map(([e, n]) => localPosition(e, n, sampleTerrain(e, n) + 2.2));
      if (points.length > 2) points.push(points[0].clone());
      const group = new THREE.Group();
      group.name = boundary.name;
      const shadowMaterial = new THREE.MeshBasicMaterial({
        color: "#43000d", transparent: true, opacity: 0.98, depthTest: false,
      });
      const redMaterial = new THREE.MeshBasicMaterial({
        color: "#ff001f", transparent: true, opacity: 0.96, depthTest: false,
      });
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 1) continue;
        [
          { width: 24, height: 0.56, material: shadowMaterial, lift: 0.00 },
          { width: 12, height: 0.72, material: redMaterial, lift: 0.35 },
        ].forEach((style) => {
          const strip = new THREE.Mesh(new THREE.BoxGeometry(length, style.height, style.width), style.material);
          strip.position.set((start.x + end.x) / 2, (start.y + end.y) / 2 + style.lift, (start.z + end.z) / 2);
          strip.rotation.y = -Math.atan2(dz, dx);
          strip.renderOrder = 19;
          group.add(strip);
        });
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({
          color: "#ffffff",
          dashSize: 72,
          gapSize: 34,
          transparent: false,
          opacity: 1,
          depthTest: false,
        })
      );
      line.computeLineDistances();
      line.name = `${boundary.name}-white-dash`;
      line.renderOrder = 21;
      group.userData = { kind: "report-boundary", data: boundary };
      group.add(line);
      reportBoundaryObjects.set(boundary.id, group);
      reportBoundaryGroup.add(group);
    });
  }

  function createReferenceOverlays() {
    buildingReferenceGroup.visible = false;
    engineeringDrawingGroup.visible = false;
    addTerrainOverlay(
      "assets/regional_buildx_z17.png?v=20260827-mobile-portrait-v8",
      buildingReferenceGroup,
      0.78,
      "NLSC-BUILDX-reference",
      8
    );
    addSubextentOverlay(
      "assets/pilot_engineering_drawing_overlay.png?v=20260821-grid-fixed",
      DATA.extent,
      engineeringDrawingGroup,
      0.72,
      "DHDK-001-georeferenced",
      9
    );
  }

  function addTerrainOverlay(url, group, opacity, name, renderOrder) {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(terrainMesh.geometry.clone(), material);
    mesh.name = name;
    mesh.position.y = 0.08 + (renderOrder - 8) * 0.04;
    mesh.renderOrder = renderOrder;
    group.add(mesh);
    new THREE.TextureLoader().load(url, (texture) => {
      texture.encoding = THREE.sRGBEncoding;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      material.map = texture;
      material.needsUpdate = true;
    });
  }

  function addSubextentOverlay(url, extent, group, opacity, name, renderOrder) {
    const width = extent.xmax - extent.xmin;
    const height = extent.ymax - extent.ymin;
    const centerE = (extent.xmin + extent.xmax) / 2;
    const centerN = (extent.ymin + extent.ymax) / 2;
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(width, height, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.copy(localPosition(centerE, centerN, sampleTerrain(centerE, centerN) + 0.55));
    mesh.renderOrder = renderOrder;
    group.add(mesh);
    new THREE.TextureLoader().load(url, (texture) => {
      texture.encoding = THREE.sRGBEncoding;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      material.map = texture;
      material.needsUpdate = true;
    });
  }

  function loadBasemap() {
    const loader = new THREE.TextureLoader();
    basemapTextures.dtm = createDtmTexture();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; loading.classList.add("ready"); } };
    const acceptTexture = (key, texture) => {
      basemapTextures[key] = texture;
      basemapLoadState[key] = "ready";
      texture.encoding = THREE.sRGBEncoding;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      applySelectedBasemap();
      if (key === state.basemapSource) finish();
    };
    const rejectTexture = (key) => {
      basemapLoadState[key] = "failed";
      applySelectedBasemap();
      if (key === state.basemapSource) finish();
    };
    loader.load("assets/regional_photo2_web_2026.jpg?v=20260827-mobile-portrait-v8", (texture) => acceptTexture("nlsc", texture), undefined, () => {
      loader.load("assets/regional_photo2_2026.jpg?v=20260827-mobile-portrait-v8", (texture) => acceptTexture("nlsc", texture), undefined, () => rejectTexture("nlsc"));
    });
    loader.load("assets/regional_emap5_reference.png?v=20260827-mobile-portrait-v8", (texture) => acceptTexture("emap5", texture), undefined, () => rejectTexture("emap5"));
    applySelectedBasemap();
    window.setTimeout(finish, 5000);
  }

  function createDtmTexture() {
    const terrain = REGIONAL.terrain;
    const size = 512;
    const surface = document.createElement("canvas");
    surface.width = size;
    surface.height = size;
    const context = surface.getContext("2d", { alpha: false });
    const pixels = context.createImageData(size, size);
    let min = Infinity;
    let max = -Infinity;
    terrain.heightsSouthToNorth.forEach((row) => row.forEach((value) => {
      if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
    }));
    const span = Math.max(0.2, max - min);
    for (let py = 0; py < size; py += 1) {
      const row = Math.round((size - 1 - py) / (size - 1) * (terrain.rows - 1));
      for (let px = 0; px < size; px += 1) {
        const col = Math.round(px / (size - 1) * (terrain.cols - 1));
        const height = terrain.heightsSouthToNorth[row][col];
        const land = !terrain.landMaskSouthToNorth || terrain.landMaskSouthToNorth[row][col];
        const normalized = THREE.MathUtils.clamp((height - min) / span, 0, 1);
        const shade = Math.round(44 + Math.pow(normalized, 0.48) * 176);
        const offset = (py * size + px) * 4;
        pixels.data[offset] = land ? Math.round(shade * 0.76) : 34;
        pixels.data[offset + 1] = land ? Math.round(shade * 0.96) : 105;
        pixels.data[offset + 2] = land ? Math.round(shade * 0.72) : 142;
        pixels.data[offset + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    const texture = new THREE.CanvasTexture(surface);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  function applySelectedBasemap() {
    const toggle = document.getElementById("toggle-basemap");
    const enabled = toggle ? toggle.checked : true;
    const selectedTexture = basemapTextures[state.basemapSource];
    const fallbackTexture = basemapTextures.nlsc || basemapTextures.emap5 || basemapTextures.dtm;
    terrainMesh.material.map = enabled ? (selectedTexture || fallbackTexture) : null;
    terrainMesh.material.color.set(enabled && terrainMesh.material.map ? "#ffffff" : "#748d7c");
    terrainMesh.material.needsUpdate = true;

    const note = document.getElementById("basemap-source-note");
    const notes = {
      nlsc: "NLSC PHOTO2正射影像（衛星圖類）；無道路、地名與POI文字註記。",
      emap5: "NLSC臺灣通用電子地圖EMAP5公開影像；用於河道、道路與空間套疊檢核。",
      dtm: "NLSC 2025版20m DTM高程設色；海域以藍色、陸域依相對高程著色。",
    };
    const failed = enabled && basemapLoadState[state.basemapSource] === "failed";
    const pending = enabled && basemapLoadState[state.basemapSource] === "pending";
    if (note) note.textContent = `${notes[state.basemapSource] || notes.nlsc}${pending ? " 原選圖仍在載入，暫顯示政府圖資備援。" : ""}${failed ? " 原選圖載入失敗，已自動顯示政府圖資備援。" : ""} 完整來源見「政府公開資料清冊」。`;
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      basemapSource: state.basemapSource,
      basemapTextureReady: Boolean(terrainMesh.material.map),
      basemapLoadState: { ...basemapLoadState },
    });
  }

  function createRiver() {
    const hydro = REGIONAL.hydrography;
    const riverMask = hydro?.mainRiverMaskSouthToNorth;
    if (riverMask?.length) {
      const cells = [];
      riverMask.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
        if (value) cells.push({ row: rowIndex, col: colIndex });
      }));
      const geometry = new THREE.PlaneGeometry(CELL * 1.02, CELL * 1.02);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshPhysicalMaterial({
        color: "#1f8fc5",
        roughness: 0.24,
        metalness: 0.01,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      riverMesh = new THREE.InstancedMesh(geometry, material, cells.length);
      const matrix = new THREE.Matrix4();
      cells.forEach((cell, index) => {
        const e = REGIONAL.terrain.extent.xmin + (cell.col + 0.5) * CELL;
        const n = REGIONAL.terrain.extent.ymin + (cell.row + 0.5) * CELL;
        matrix.makeTranslation(e - CENTER_E, sampleTerrain(e,n) - DATUM + 0.15, CENTER_N - n);
        riverMesh.setMatrixAt(index, matrix);
      });
      riverMesh.instanceMatrix.needsUpdate = true;
      riverMesh.name = "REFERENCE-40m-river-mask-not-surveyed";
      riverMesh.renderOrder = 4;
      riverGroup.add(riverMesh);
      return;
    }
    const points = DATA.infrastructure.riverPolygon.map(([e, n]) => [e - CENTER_E, CENTER_N - n]);
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(([x, z]) => shape.lineTo(x, z));
    shape.closePath();
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshPhysicalMaterial({
      color: "#176b8c",
      roughness: 0.3,
      metalness: 0.02,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    riverMesh = new THREE.Mesh(geometry, material);
    riverMesh.renderOrder = 4;
    riverGroup.add(riverMesh);
  }

  function createRiverQaOverlay() {
    const riverMask = REGIONAL.hydrography?.mainRiverMaskSouthToNorth;
    riverQaGroup.name = "NLSC-main-river-alignment-QA";
    riverQaGroup.visible = false;
    if (!riverMask?.length) return;
    const cells = [];
    riverMask.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
      if (value) cells.push({ row: rowIndex, col: colIndex });
    }));
    const geometry = new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: "#00f5ff", wireframe: true, transparent: true, opacity: 0.96,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
    const matrix = new THREE.Matrix4();
    cells.forEach((cell, index) => {
      const e = REGIONAL.terrain.extent.xmin + (cell.col + 0.5) * CELL;
      const n = REGIONAL.terrain.extent.ymin + (cell.row + 0.5) * CELL;
      const y = sampleTerrain(e, n) - DATUM + 0.15;
      matrix.makeTranslation(e - CENTER_E, y, CENTER_N - n);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 22;
    mesh.name = "NLSC-EMAP5-main-river-QA-grid";
    riverQaGroup.add(mesh);
  }

  function markClickable(object, kind, data) {
    object.userData = { ...object.userData, kind, data };
    clickableMeshes.push(object);
    return object;
  }

  function addWhiteVertexColors(geometry) {
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    colors.fill(1);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  function createDikes() {
    DATA.infrastructure.dikes.forEach((dike, dikeIndex) => {
      const group = new THREE.Group();
      group.name = dike.name;
      const color = dikeIndex === 0 ? "#d48f61" : "#e0ae73";
      for (let i = 0; i < dike.points.length - 1; i += 1) {
        const [e1, n1] = dike.points[i];
        const [e2, n2] = dike.points[i + 1];
        const a = localPosition(e1, n1, dike.topElev - 0.48);
        const b = localPosition(e2, n2, dike.topElev - 0.48);
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(length, 0.96, 4.2),
          new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 })
        );
        mesh.position.set((a.x + b.x) / 2, a.y, (a.z + b.z) / 2);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        markClickable(mesh, "dike", dike);
        group.add(mesh);
      }
      infrastructureGroup.add(group);
      engineeringObjects.set(dike.id, group);
      const mid = dike.points[Math.floor(dike.points.length / 2)];
      addLabel(dike.name, localPosition(mid[0], mid[1], dike.topElev + 1.8), group, { category: "engineering", filterCategory: "engineering" });
    });
  }

  function createGates() {
    DATA.infrastructure.gates.forEach((gate) => {
      const group = gate.id === "G-DESIGN" ? createNewGate(gate) : createOldGate(gate);
      group.traverse((object) => {
        if (!object.isMesh || !object.material || !object.material.color) return;
        object.userData.renderClass = gate.id === "G-DESIGN" ? "design" : "existing";
        object.userData.currentColor = object.material.color.clone();
        object.userData.whiteColor = new THREE.Color(gate.id === "G-DESIGN" ? "#f5f5f3" : "#eceeea");
      });
      infrastructureGroup.add(group);
      engineeringObjects.set(gate.id, group);
      addLabel(gate.id === 'G-DESIGN' ? '新建五結防潮閘門' : gate.name, new THREE.Vector3(0, 8.5, 0), group, { category: "engineering", filterCategory: "engineering", maxDistance:28000, priority:100 });
    });
  }

  function applyConstructionStateVisibility() {
    const before = state.constructionState === "before";
    const existingGate = engineeringObjects.get("G-EXISTING");
    const designGate = engineeringObjects.get("G-DESIGN");
    if (existingGate) existingGate.visible = before;
    if (designGate) designGate.visible = !before;
    const select = document.getElementById("construction-state");
    const raw = rawScenarioById(state.scenarioId);
    if (select) {
      select.value = state.constructionState;
      Array.from(select.options).forEach(option => {
        option.disabled = !supportsConstruction(raw, option.value);
      });
    }
    const note = document.getElementById("construction-state-note");
    if (note) note.textContent = raw?.comparisonUnavailableReason || (before
      ? "顯示既有閘門；通水遮斷率約20.7%，比較基準為工程未改善。"
      : "顯示改善工程白模；通水遮斷率約8.6%，同洪峰比較風險變化。");
  }

  function createNewGate(gate) {
    const group = new THREE.Group();
    group.name = gate.name;
    group.position.copy(localPosition(gate.e, gate.n, DATUM));
    group.rotation.y = THREE.MathUtils.degToRad(-gate.angleDeg);
    const concrete = new THREE.MeshStandardMaterial({ color: gate.materialColors?.primary || "#f7f7f5", roughness: 0.82 });
    const steel = new THREE.MeshStandardMaterial({ color: gate.materialColors?.secondary || "#e7eaeb", roughness: 0.68, metalness: 0.08 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(gate.length + 8, 1.2, 8), concrete);
    deck.position.y = gate.topElev - DATUM + 2.2;
    deck.castShadow = true;
    deck.receiveShadow = true;
    markClickable(deck, "gate", gate);
    group.add(deck);

    const bays = [30.5, 30.5, 30.5, 30.5, 30.5, 30.5, 9];
    const pierWidth = (gate.length - bays.reduce((sum, width) => sum + width, 0)) / (bays.length + 1);
    let cursor = -gate.length / 2;
    for (let i = 0; i <= bays.length; i += 1) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(pierWidth, 7.2, 10), concrete);
      pier.position.set(cursor + pierWidth / 2, 1.0, 0);
      pier.castShadow = true;
      pier.receiveShadow = true;
      markClickable(pier, "gate", gate);
      group.add(pier);
      cursor += pierWidth;
      if (i < bays.length) {
        const width = bays[i];
        const panel = new THREE.Mesh(new THREE.BoxGeometry(Math.max(2, width - 0.4), 2.0, 1.2), steel);
        panel.position.set(cursor + width / 2, 0.05, 0);
        markClickable(panel, "gate", gate);
        group.add(panel);
        cursor += width;
      }
    }
    const controlHouse = new THREE.Mesh(
      new THREE.BoxGeometry(22, 7.5, 15),
      new THREE.MeshStandardMaterial({ color: "#f8f8f6", roughness: 0.82 })
    );
    controlHouse.position.set(-gate.length / 2 - 14, 6.3, -7);
    controlHouse.castShadow = true;
    markClickable(controlHouse, "gate", gate);
    group.add(controlHouse);

    const houseRoof = new THREE.Mesh(
      new THREE.BoxGeometry(24, 0.8, 17),
      new THREE.MeshStandardMaterial({ color: "#e2e6e7", roughness: 0.74, metalness: 0.04 })
    );
    houseRoof.position.set(-gate.length / 2 - 14, 10.45, -7);
    markClickable(houseRoof, "gate", gate);
    group.add(houseRoof);

    [-5.1, 5.1].forEach((z) => {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(gate.length + 12, 0.32, 0.32),
        new THREE.MeshStandardMaterial({ color: "#c8ced1", roughness: 0.52, metalness: 0.14 })
      );
      rail.position.set(0, gate.topElev - DATUM + 3.55, z);
      markClickable(rail, "gate", gate);
      group.add(rail);
    });
    return group;
  }

  function createOldGate(gate) {
    const group = new THREE.Group();
    group.name = gate.name;
    group.position.copy(localPosition(gate.e, gate.n, DATUM));
    group.rotation.y = THREE.MathUtils.degToRad(-gate.angleDeg);
    const concrete = new THREE.MeshStandardMaterial({ color: gate.materialColors?.primary || "#8d8c85", roughness: 0.9 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(gate.length, 1, 5.5), concrete);
    deck.position.y = gate.topElev - DATUM + 1.4;
    markClickable(deck, "gate", gate);
    group.add(deck);
    const count = 18;
    for (let i = 0; i <= count; i += 1) {
      const x = -gate.length / 2 + (gate.length / count) * i;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.3, 4.6, 6), concrete);
      pier.position.set(x, 0.7, 0);
      markClickable(pier, "gate", gate);
      group.add(pier);
    }
    return group;
  }

  function createRegionalBuildings() {
    const buildings = contextBuildings;
    if (!buildings.length) return;
    const geometry = addWhiteVertexColors(new THREE.BoxGeometry(1, 1, 1));
    const material = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.86,
      metalness: 0,
      vertexColors: true,
    });
    regionalBuildingMesh = new THREE.InstancedMesh(geometry, material, buildings.length);
    regionalBuildingMesh.name = "NLSC-regional-LOD1-buildings";
    regionalBuildingMesh.castShadow = false;
    regionalBuildingMesh.receiveShadow = true;
    regionalBuildingMesh.renderOrder = 10;
    regionalBuildingMesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    buildings.forEach((building, index) => {
      position.copy(localPosition(building.e, building.n, building.groundElev + building.height / 2));
      quaternion.setFromAxisAngle(up, THREE.MathUtils.degToRad(-building.angleDeg));
      scale.set(building.width, building.height, building.depth);
      matrix.compose(position, quaternion, scale);
      regionalBuildingMesh.setMatrixAt(index, matrix);
      regionalBuildingMesh.setColorAt(index, color.set(building.facadeColor || "#bbb8b0"));
    });
    regionalBuildingMesh.instanceMatrix.needsUpdate = true;
    if (regionalBuildingMesh.instanceColor) regionalBuildingMesh.instanceColor.needsUpdate = true;
    regionalBuildingMesh.userData = { kind: "regional-building", data: buildings };
    clickableMeshes.push(regionalBuildingMesh);
    contextBuildingGroup.add(regionalBuildingMesh);
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      regionalClickableCount: buildings.length,
      detailClickableCount: DATA.buildings.length,
      totalClickableBuildingCount: buildings.length + DATA.buildings.length,
    });

    const riskMaterial = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      vertexColors: true,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });
    regionalRiskOverlayMesh = new THREE.InstancedMesh(geometry.clone(), riskMaterial, buildings.length);
    regionalRiskOverlayMesh.name = "affected-buildings-red-visibility-overlay";
    regionalRiskOverlayMesh.renderOrder = 90;
    regionalRiskOverlayMesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    buildings.forEach((building, index) => {
      position.copy(localPosition(building.e, building.n, building.groundElev + building.height / 2 + 0.55));
      quaternion.setFromAxisAngle(up, THREE.MathUtils.degToRad(-building.angleDeg));
      scale.set(building.width * 1.14, building.height * 1.10 + 1.1, building.depth * 1.14);
      matrix.compose(position, quaternion, scale);
      regionalBuildingMatrices[index] = matrix.clone();
      regionalRiskOverlayMesh.setMatrixAt(index, hidden);
      regionalRiskOverlayMesh.setColorAt(index, riskColors["低"]);
    });
    regionalRiskOverlayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    regionalRiskOverlayMesh.instanceMatrix.needsUpdate = true;
    if (regionalRiskOverlayMesh.instanceColor) regionalRiskOverlayMesh.instanceColor.needsUpdate = true;
    contextBuildingGroup.add(regionalRiskOverlayMesh);
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      regionalGeometryColorCount: geometry.getAttribute("color")?.count || 0,
      regionalInstanceColorCount: regionalBuildingMesh.instanceColor?.count || 0,
      riskOverlayInstanceColorCount: regionalRiskOverlayMesh.instanceColor?.count || 0,
    });
  }

  function createBuildings() {
    DATA.buildings.forEach((building) => {
      if (!Array.isArray(building.footprint) || building.footprint.length < 4) return;
      const group = new THREE.Group();
      group.name = building.id;
      group.position.y = building.groundElev - DATUM;
      group.userData = { kind: "building", data: building };

      const shape = new THREE.Shape();
      const ring = building.footprint[0][0] === building.footprint[building.footprint.length - 1][0]
        && building.footprint[0][1] === building.footprint[building.footprint.length - 1][1]
        ? building.footprint.slice(0, -1) : building.footprint;
      ring.forEach(([e, n], pointIndex) => {
        const x = e - CENTER_E;
        const y = n - CENTER_N;
        if (pointIndex === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      shape.closePath();

      const facadeMaterial = new THREE.MeshStandardMaterial({
        color: building.facadeColor || "#d8d3c8", roughness: 0.8, metalness: 0.015,
      });
      const bodyGeometry = new THREE.ExtrudeGeometry(shape, {
        depth: building.height,
        bevelEnabled: false,
        curveSegments: 1,
      });
      bodyGeometry.rotateX(-Math.PI / 2);
      const body = new THREE.Mesh(bodyGeometry, facadeMaterial);
      body.userData.currentColor = facadeMaterial.color.clone();
      body.userData.baseColor = facadeMaterial.color.clone();
      body.castShadow = true;
      body.receiveShadow = true;
      markClickable(body, "building", building);
      group.add(body);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(body.geometry),
        new THREE.LineBasicMaterial({ color: "#53646a", transparent: true, opacity: 0.62 })
      );
      group.add(outline);

      const roofMaterial = new THREE.MeshStandardMaterial({
        color: building.roofColor || "#75584a", roughness: 0.82,
      });
      const roofGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.42, bevelEnabled: false, curveSegments: 1 });
      roofGeometry.rotateX(-Math.PI / 2);
      const roof = new THREE.Mesh(roofGeometry, roofMaterial);
      roof.userData.currentColor = roofMaterial.color.clone();
      roof.userData.baseColor = roofMaterial.color.clone();
      roof.position.y = building.height;
      roof.castShadow = true;
      markClickable(roof, "building", building);
      group.add(roof);

      const riskGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false, curveSegments: 1 });
      riskGeometry.rotateX(-Math.PI / 2);
      const riskBand = new THREE.Mesh(
        riskGeometry,
        new THREE.MeshBasicMaterial({ color: riskColors["無"], transparent: true, opacity: 0.90, depthWrite: false, depthTest: true })
      );
      riskBand.position.y = building.height + 0.52;
      riskBand.renderOrder = 14;
      riskBand.visible = false;
      group.add(riskBand);

      buildingGroup.add(group);
      buildingObjects.set(building.id, { group, body, roof, riskBand, building });
    });
    const representative = buildingObjects.values().next().value;
    if (representative) {
      const p = localPosition(representative.building.e, representative.building.n, representative.building.groundElev + representative.building.height + 5);
      addLabel("NLSC建物框衍生3D", p, buildingGroup, { category: "building", filterCategory: "building" });
    }
  }

  function createCadastralReference() {
    const parcels = DATA.cadastral && Array.isArray(DATA.cadastral.parcels) ? DATA.cadastral.parcels : [];
    parcels.forEach((parcel) => {
      if (!Array.isArray(parcel.polygon) || parcel.polygon.length < 4) return;
      const points = parcel.polygon[0][0] === parcel.polygon[parcel.polygon.length - 1][0]
        && parcel.polygon[0][1] === parcel.polygon[parcel.polygon.length - 1][1]
        ? parcel.polygon.slice(0, -1) : parcel.polygon;
      const averageElevation = points.reduce((sum, point) => sum + sampleTerrain(point[0], point[1]), 0) / points.length;
      const shape = new THREE.Shape();
      points.forEach((point, index) => {
        const x = point[0] - CENTER_E;
        const y = point[1] - CENTER_N;
        if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape);
      const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: "#f3c546",
        transparent: true,
        opacity: 0.075,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = averageElevation - DATUM + 0.56;
      fill.renderOrder = 7;
      markClickable(fill, "parcel", parcel);

      const linePoints = points.map((point) => localPosition(
        point[0], point[1], sampleTerrain(point[0], point[1]) + 0.72
      ));
      linePoints.push(linePoints[0].clone());
      const boundary = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(linePoints),
        new THREE.LineBasicMaterial({ color: "#ffd563", transparent: true, opacity: 0.92, depthTest: false })
      );
      boundary.renderOrder = 12;
      const group = new THREE.Group();
      group.name = parcel.displayName || parcel.id;
      group.add(fill, boundary);
      cadastralGroup.add(group);
      parcelObjects.set(parcel.id, group);
    });
  }

  function createGableRoof(width, depth, height, material) {
    const halfW = width / 2;
    const halfD = depth / 2;
    const positions = new Float32Array([
      -halfW, 0, -halfD, halfW, 0, -halfD, 0, height, -halfD,
      -halfW, 0, halfD, halfW, 0, halfD, 0, height, halfD,
    ]);
    const indices = [0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 1, 4, 5, 1, 5, 2, 0, 3, 4, 0, 4, 1];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  function addFacadeDetails(group, building) {
    const windowMaterial = new THREE.MeshStandardMaterial({
      color: "#4e7180", roughness: 0.28, metalness: 0.12, emissive: new THREE.Color("#0f1e23"),
    });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: "#5f4d42", roughness: 0.84 });
    const floors = Math.max(1, building.modelStoreys || Math.round(building.height / 3.2));
    for (let floor = 0; floor < floors; floor += 1) {
      const y = Math.min(building.height - 0.8, 2.15 + floor * 3.0);
      [-1, 1].forEach((side) => {
        const windowBand = new THREE.Mesh(
          new THREE.BoxGeometry(building.width * 0.54, 0.68, 0.12), windowMaterial
        );
        windowBand.position.set(0, y, side * (building.depth / 2 + 0.065));
        group.add(windowBand);
      });
    }
    const sideWindow = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.72, building.depth * 0.34), windowMaterial
    );
    sideWindow.position.set(building.width / 2 + 0.065, 2.15, 0);
    group.add(sideWindow);
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.5, 0.14), doorMaterial);
    door.position.set(-building.width * 0.28, 1.25, building.depth / 2 + 0.075);
    group.add(door);
  }

  function createContextMarkers() {
    DATA.infrastructure.context.forEach((item) => {
      const group = new THREE.Group();
      const p = localPosition(item.e, item.n, sampleTerrain(item.e, item.n) + 0.5);
      group.position.copy(p);
      if (item.type === "direction") {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.6, 0.8, 12, 8),
          new THREE.MeshStandardMaterial({ color: "#5bd5d0", roughness: 0.45, metalness: 0.2 })
        );
        post.position.y = 6;
        const arrow = new THREE.Mesh(
          new THREE.ConeGeometry(3.2, 7, 4),
          new THREE.MeshStandardMaterial({ color: "#ffbd55", roughness: 0.55 })
        );
        arrow.rotation.z = Math.PI / 2;
        arrow.position.set(-4, 12, 0);
        markClickable(post, "context", item);
        markClickable(arrow, "context", item);
        group.add(post, arrow);
      } else {
        const roadMarker = new THREE.Mesh(
          new THREE.BoxGeometry(34, 0.5, 4),
          new THREE.MeshStandardMaterial({ color: "#e7c565", roughness: 0.9 })
        );
        roadMarker.position.y = 0.5;
        roadMarker.rotation.y = Math.PI / 4;
        markClickable(roadMarker, "context", item);
        group.add(roadMarker);
      }
      infrastructureGroup.add(group);
      engineeringObjects.set(item.id, group);
      addLabel(item.name, new THREE.Vector3(0, 16, 0), group, { category: item.type === "road" ? "road" : "engineering", filterCategory: item.type === "road" ? "road" : "engineering" });
    });
  }

  function createRegionalLabels() {
    (REGIONAL.sceneLabels || []).forEach((item) => {
      if(item.id === 'LBL-GATE') return; // Use the single gate-attached label for each construction state.
      const anchorGroup = new THREE.Group();
      anchorGroup.position.copy(localPosition(item.e, item.n, sampleTerrain(item.e, item.n) + 2.2));
      infrastructureGroup.add(anchorGroup);
      addLabel(item.name, new THREE.Vector3(0, 0, 0), anchorGroup, {
        category: item.category,
        filterCategory: labelFilterCategory(item.category),
        maxDistance: item.priority >= 85 ? 28000 : 19000,
        priority: item.priority || 50,
      });
    });
  }

  function sampleTerrain(e, n) {
    const terrain = REGIONAL.terrain;
    const col = THREE.MathUtils.clamp(Math.round((e - terrain.extent.xmin) / CELL), 0, terrain.cols - 1);
    const row = THREE.MathUtils.clamp(Math.round((n - terrain.extent.ymin) / CELL), 0, terrain.rows - 1);
    return terrain.heightsSouthToNorth[row][col];
  }

  function pointInPolygon(e, n, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];
      const intersects = ((yi > n) !== (yj > n)) && (e < (xj - xi) * (n - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function distanceToSegment(e, n, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    if (!length2) return Math.hypot(e - a[0], n - a[1]);
    const t = THREE.MathUtils.clamp(((e - a[0]) * dx + (n - a[1]) * dy) / length2, 0, 1);
    return Math.hypot(e - (a[0] + t * dx), n - (a[1] + t * dy));
  }

  function isFloodSeedCell(e, n) {
    if (pointInPolygon(e, n, DATA.infrastructure.riverPolygon)) return true;
    return (REGIONAL.floodSeedLines || []).some((line) =>
      line.points.slice(1).some((point, index) =>
        distanceToSegment(e, n, line.points[index], point) <= CELL * 0.82
      )
    );
  }

  function floodProgressForOffset() { return state.displayFlowCms <= FLOW.config.startFlowCms ? 0 : 1; }

  function cellInsideScope(e, n, scope = state.analysisScope) {
    if (scope !== "detail") return true;
    return e >= DATA.extent.xmin && e <= DATA.extent.xmax && n >= DATA.extent.ymin && n <= DATA.extent.ymax;
  }

  function reportedNoOvertopping(scenario, level) {
    return scenario?.operation?.reportedNoOvertopping === true && scenario.constructionState === 'after' && level <= scenario.effectiveLevel + 1e-6;
  }

  function computeConnectedFlood(level, progress, scope = state.analysisScope, scenario = currentScenario(), event = null) {
    const terrain = REGIONAL.terrain;
    const active = new Set();
    const cellData = new Map();
    if (progress <= 1e-6) return { active, cells: [], cellData };
    const flowCms = event?.flowCms ?? scenario.peakFlowCms;
    const eventHours = event?.hours ?? Infinity;
    if (flowCms <= FLOW.config.startFlowCms || (scenario.constructionState === 'after' && flowCms <= 750)) return {active,cells:[],cellData,basis:'USER_ASSUMED_750_THRESHOLD'};
    // Report 1-6: no main-channel overtopping in normal 750 cms operation.
    // This does not imply zero lowland drainage risk.
    if (reportedNoOvertopping(scenario, level)) return { active, cells: [], cellData, basis:'REPORT_NO_MAIN_CHANNEL_OVERTOPPING', lowlandRisk:null };
    const hydro = REGIONAL.hydrography;
    const mappedWater = hydro?.mappedWaterMaskSouthToNorth;
    const mainRiver = hydro?.mainRiverMaskSouthToNorth;
    const spill = hydro?.spillElevationSouthToNorth;
    const arrival = hydro?.arrivalDistanceCellsSouthToNorth;
    const maximumArrival = progress < 0.999 && HYDRO_MAX_ARRIVAL > 0
      ? Math.max(1, Math.ceil(Math.pow(progress, 0.72) * HYDRO_MAX_ARRIVAL))
      : Infinity;
    const cellKey = (row, col) => `${row}:${col}`;
    for (let row = 0; row < terrain.rows - 1; row += 1) {
      const n = terrain.extent.ymin + (row + 0.5) * CELL;
      for (let col = 0; col < terrain.cols - 1; col += 1) {
        const e = terrain.extent.xmin + (col + 0.5) * CELL;
        if (!cellInsideScope(e, n, scope)) continue;
        const mask = terrain.landMaskSouthToNorth;
        if (mask) {
          const validCorners = mask[row][col] + mask[row + 1][col] + mask[row][col + 1] + mask[row + 1][col + 1];
          if (validCorners < 2) continue;
        }
        // Existing mapped water remains the river/pond surface and is not
        // painted as overbank inundation.  Only land reached across the DTM
        // spill surface is rendered as the blue flood grid.
        if (mainRiver?.[row]?.[col] || mappedWater?.[row]?.[col]) continue;
        const z = (
          terrain.heightsSouthToNorth[row][col] +
          terrain.heightsSouthToNorth[row + 1][col] +
          terrain.heightsSouthToNorth[row][col + 1] +
          terrain.heightsSouthToNorth[row + 1][col + 1]
        ) / 4;
        const depth = level - z;
        const spillElevation = spill?.[row]?.[col];
        const arrivalDistance = arrival?.[row]?.[col];
        if (arrivalDistance == null || arrivalDistance < 0 || arrivalDistance > maximumArrival) continue;
        if (depth <= 0.005 || spillElevation == null || spillElevation > level + 1e-6) continue;
        const onset = FLOW.onset(Math.max(spillElevation,z+0.005001),arrivalDistance,scenario.constructionState);
        if (onset.hours == null || eventHours < onset.hours) continue;
        const arrivalWetting = maximumArrival === Infinity ? 1 : THREE.MathUtils.clamp((maximumArrival - arrivalDistance + 1) / 10, 0.12, 1);
        const wetting = THREE.MathUtils.clamp((level - Math.max(z, spillElevation)) / 0.18, 0.18, 1) * arrivalWetting;
        const key = cellKey(row, col);
        const cell = { row, col, e, n, depth, spillElevation, arrivalDistance, wetting, onsetFlowCms:onset.flowCms, onsetHours:onset.hours };
        active.add(key);
        cellData.set(key, cell);
      }
    }
    return { active, cells: Array.from(cellData.values()), cellData };
  }

  function rebuildFlood() {
    worldRoot.remove(floodGroup);
    disposeGroup(floodGroup);
    floodGroup = new THREE.Group();
    floodGroup.name = "dynamic-flood";
    worldRoot.add(floodGroup);
    const level = currentWaterLevel();
    const flood = computeConnectedFlood(level, floodProgressForOffset(), state.analysisScope, currentScenario(), {flowCms:state.displayFlowCms,hours:state.eventHours});
    activeFloodCells = flood.active;
    activeFloodCellData = flood.cellData;
    const cells = flood.cells;

    if (cells.length) {
      const geometry = addWhiteVertexColors(new THREE.PlaneGeometry(CELL * 0.94, CELL * 0.94));
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        color: "#ffffff",
        transparent: true,
        opacity: 0.50,
        depthWrite: false,
        vertexColors: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      cells.forEach((cell, index) => {
        matrix.makeTranslation(cell.e - CENTER_E, level - DATUM + 0.09, CENTER_N - cell.n);
        mesh.setMatrixAt(index, matrix);
        depthColor(cell.depth * (0.42 + cell.wetting * 0.58), color);
        mesh.setColorAt(index, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.renderOrder = 5;
      mesh.name = "inundation-cells";
      floodGroup.add(mesh);
    }
    floodGroup.visible = document.getElementById("toggle-flood").checked;
    return activeFloodCells;
  }

  function buildingContainsPoint(building, e, n) {
    if (building.footprint?.length >= 3) return pointInPolygon(e, n, building.footprint);
    const width = Number(building.width || Math.sqrt(building.areaM2 || 36));
    const depth = Number(building.depth || Math.sqrt(building.areaM2 || 36));
    const angle = THREE.MathUtils.degToRad(Number(building.angleDeg || 0));
    const dx = e - building.e;
    const dy = n - building.n;
    const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
    const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.abs(localX) <= width / 2 && Math.abs(localY) <= depth / 2;
  }

  function buildingBounds(building) {
    if (building.footprint?.length) {
      const es = building.footprint.map((point) => point[0]);
      const ns = building.footprint.map((point) => point[1]);
      return { minE: Math.min(...es), maxE: Math.max(...es), minN: Math.min(...ns), maxN: Math.max(...ns) };
    }
    const width = Number(building.width || Math.sqrt(building.areaM2 || 36));
    const depth = Number(building.depth || Math.sqrt(building.areaM2 || 36));
    const radius = Math.hypot(width, depth) / 2;
    return { minE: building.e - radius, maxE: building.e + radius, minN: building.n - radius, maxN: building.n + radius };
  }

  function buildingFloodState(building, floodCells = activeFloodCells, level = currentWaterLevel(), scope = state.analysisScope, floodData = activeFloodCellData) {
    if (building.officialId && !Number.isFinite(building.groundElev)) return {connected:false,depth:0,visualDepth:0,wetting:0,unknown:true};
    if (building.floodCellKeys) {
      let wetting = 0;
      if (cellInsideScope(building.e, building.n, scope)) building.floodCellKeys.forEach(key => {
        if (floodCells?.has(key)) {
          const cell=floodData?.get(key);
          if(floodCells===activeFloodCells && Number.isFinite(state.eventHours) && cell){
            const onset=FLOW.onset(Math.max(cell.spillElevation,level-cell.depth+0.005001,building.groundElev+0.005001),cell.arrivalDistance,state.constructionState);
            if(onset.hours==null||state.eventHours<onset.hours)return;
          }
          wetting = Math.max(wetting, cell?.wetting || 1);
        }
      });
      const depth = wetting ? Math.max(0, level - building.groundElev) : 0;
      return { connected: depth > 0, depth, visualDepth: depth * wetting, wetting };
    }
    if (!floodCells || !floodCells.size || !cellInsideScope(building.e, building.n, scope)) {
      return { connected: false, depth: 0, visualDepth: 0, wetting: 0 };
    }
    const terrain = REGIONAL.terrain;
    const bounds = buildingBounds(building);
    const minCol = THREE.MathUtils.clamp(Math.floor((bounds.minE - terrain.extent.xmin) / CELL), 0, terrain.cols - 2);
    const maxCol = THREE.MathUtils.clamp(Math.floor((bounds.maxE - terrain.extent.xmin) / CELL), 0, terrain.cols - 2);
    const minRow = THREE.MathUtils.clamp(Math.floor((bounds.minN - terrain.extent.ymin) / CELL), 0, terrain.rows - 2);
    const maxRow = THREE.MathUtils.clamp(Math.floor((bounds.maxN - terrain.extent.ymin) / CELL), 0, terrain.rows - 2);
    const centerCol = THREE.MathUtils.clamp(Math.floor((building.e - terrain.extent.xmin) / CELL), 0, terrain.cols - 2);
    const centerRow = THREE.MathUtils.clamp(Math.floor((building.n - terrain.extent.ymin) / CELL), 0, terrain.rows - 2);
    let connected = false;
    let wetting = 0;
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const key = `${row}:${col}`;
        if (!floodCells.has(key)) continue;
        const e = terrain.extent.xmin + (col + 0.5) * CELL;
        const n = terrain.extent.ymin + (row + 0.5) * CELL;
        if ((row !== centerRow || col !== centerCol) && !buildingContainsPoint(building, e, n)) continue;
        const cell=floodData?.get(key);
        if(floodCells===activeFloodCells && Number.isFinite(state.eventHours) && cell){
          const onset=FLOW.onset(Math.max(cell.spillElevation,level-cell.depth+0.005001,building.groundElev+0.005001),cell.arrivalDistance,state.constructionState);
          if(onset.hours==null||state.eventHours<onset.hours)continue;
        }
        connected = true;
        wetting = Math.max(wetting, floodData?.get(key)?.wetting || 1);
      }
    }
    const depth = connected ? Math.max(0, level - building.groundElev) : 0;
    return { connected: connected && depth > 0, depth, visualDepth: depth * (0.35 + wetting * 0.65), wetting };
  }

  function isBuildingAffected(building, floodCells = activeFloodCells, scope = state.analysisScope) {
    return buildingFloodState(building, floodCells, currentWaterLevel(), scope).connected;
  }

  function depthColor(depth, target) {
    if (depth <= 0.3) return target.set("#7dd3fc");
    if (depth <= 0.5) return target.set("#38bdf8");
    if (depth <= 1.0) return target.set("#0ea5e9");
    return target.set("#2563eb");
  }

  function rawScenarioById(id) {
    return DATA.scenarios.find((item) => item.id === id);
  }

  function supportsConstruction(scenario, constructionState) {
    return !!scenario && (scenario.supportedConstructionStates || ['before', 'after']).includes(constructionState);
  }

  function resolveScenario(scenario, constructionState = state.constructionState) {
    if (!supportsConstruction(scenario, constructionState)) return null;
    const caseData = scenario.constructionCases?.[constructionState];
    if (!caseData) return { ...scenario, constructionState, constructionStateLabel: constructionState === "before" ? "工程施作前／既有閘門" : "工程施作後／改善閘門" };
    const { id: caseId, ...resolvedCase } = caseData;
    return {
      ...scenario,
      ...resolvedCase,
      constructionState: caseId || constructionState,
      constructionStateLabel: caseData.label,
      scenarioId: scenario.id,
    };
  }

  function currentScenario() {
    return resolveScenario(rawScenarioById(state.scenarioId));
  }

  function currentWaterLevel() { return FLOW.level(state.displayFlowCms,state.constructionState); }

  function riskForDepth(depth) {
    if (depth <= 0) return "無";
    if (depth <= 0.3) return "低";
    if (depth <= 0.5) return "中";
    if (depth <= 1.0) return "高";
    return "極高";
  }

  function riskVisualColor(baseColor, risk, visualDepth, target = new THREE.Color()) {
    const mix = THREE.MathUtils.clamp(0.84 + visualDepth * 0.12, 0.84, 0.99);
    return target.copy(baseColor).lerp(riskColors[risk], mix);
  }

  function selectScenario(id, resetWater = true, showAdvice = true) {
    const nextScenario = rawScenarioById(id);
    if (!nextScenario) return;
    stopFloodAnimation();
    state.scenarioId = id;
    if (!supportsConstruction(nextScenario, state.constructionState)) state.constructionState = 'after';
    state.analysisYearId = nextScenario.analysisYearId;
    document.getElementById("analysis-year").value = state.analysisYearId;
    applyConstructionStateVisibility();
    renderScenarioButtons(state.analysisYearId);
    state.waterOffset = 0;
    state.displayFlowCms = nextScenario.peakFlowCms;
    state.eventHours = Infinity;
    state.eventActive = false;
    document.getElementById("water-slider").value = state.waterOffset.toFixed(2);
    document.querySelectorAll(".scenario-button").forEach((button) => {
      const active = button.dataset.scenario === id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateScenarioPresentation();
    if (showAdvice && false) openAdviceModal(currentScenario());
  }

  function selectConstructionState(constructionState, resetWater = true, showAdvice = false) {
    if (!['before', 'after'].includes(constructionState)) return;
    if (!supportsConstruction(rawScenarioById(state.scenarioId), constructionState)) return;
    stopFloodAnimation();
    state.constructionState = constructionState;
    state.waterOffset = 0;
    state.displayFlowCms = rawScenarioById(state.scenarioId).peakFlowCms;
    state.eventHours = Infinity;
    state.eventActive = false;
    document.getElementById("water-slider").value = state.waterOffset.toFixed(2);
    applyConstructionStateVisibility();
    renderScenarioButtons(state.analysisYearId);
    updateScenarioPresentation();
    if (showAdvice) openAdviceModal(currentScenario());
  }

  function riskSummaryForScenario(scenario, constructionState, scope = state.analysisScope) {
    const key = `${scenario.id}|${constructionState}|${scope}`;
    if (comparisonRiskCache.has(key)) return comparisonRiskCache.get(key);
    const resolved = resolveScenario(scenario, constructionState);
    const flood = computeConnectedFlood(resolved.effectiveLevel, 1, scope, resolved);
    let count = 0;
    let maxDepth = 0;
    buildingsForScope(scope).forEach(({ building }) => {
      const result = buildingFloodState(building, flood.active, resolved.effectiveLevel, scope, flood.cellData);
      if (result.connected && result.depth > 0) count += 1;
      maxDepth = Math.max(maxDepth, result.depth);
    });
    const summary = { resolved, flood, count, maxDepth };
    comparisonRiskCache.set(key, summary);
    return summary;
  }

  function comparisonForScenario(scenario = rawScenarioById(state.scenarioId), scope = state.analysisScope) {
    if (scenario.comparableConstructionCases === false || !supportsConstruction(scenario, 'before') || !supportsConstruction(scenario, 'after')) return null;
    const before = riskSummaryForScenario(scenario, "before", scope);
    const after = riskSummaryForScenario(scenario, "after", scope);
    return {
      before,
      after,
      reducedCount: before.count - after.count,
      reducedPct: before.count > 0 ? (before.count - after.count) / before.count * 100 : 0,
      waterLevelReductionM: before.resolved.effectiveLevel - after.resolved.effectiveLevel,
    };
  }

  function updateImpactComparison() {
    const raw=rawScenarioById(state.scenarioId),selected=currentScenario();
    document.getElementById('scenario-operating-note').textContent=selected.operation
      ? selected.constructionState==='before'
        ? '750 cms施作前：一般通洪水位外推約EL2.89m（非既有閘門關閘歷程）。僅供敏感度，不與施作後2.46m直接計算效益。'
        : '750 cms施作後：EL2.46m為正常操作內水歷程峰，報告主流無溢堤；低地內水待算。調高水位僅是超出報告工況的敏感度。'
      : selected.shortName+'｜洪峰為需承受的來水，不是閘門容量。代表水位為1K+600洪水位，非平均潮位。';
    const before=resolveScenario(raw,'before'),after=resolveScenario(raw,'after');
    const comparison=buildingsForScope().length ? comparisonForScenario(raw) : null;
    state.currentComparison=comparison;
    document.getElementById('comparison-before').textContent='EL '+before.effectiveLevel.toFixed(2)+'m'+(before.levelQuality==='SCREENING_ESTIMATE'?'（通洪外推）':comparison?'／本次範圍風險 '+comparison.before.count+' 個':'／樣本待建立');
    document.getElementById('comparison-after').textContent='EL '+after.effectiveLevel.toFixed(2)+'m'+(raw.operation?'（操作峰；內水待算）':comparison?'／本次範圍風險 '+comparison.after.count+' 個':'／樣本待建立');
    document.getElementById('comparison-change').textContent=raw.comparableConstructionCases===false ? '工況不同，不計減災效益' : comparison ? (fullCensusActive()?'固定母體已知風險差 ':'本次範圍差 ')+comparison.reducedCount+' 個'+(fullCensusActive()?'（篩檢，非正式效益）':'（非全範圍X）') : '報告範圍X/Y待核算';
    const freeboard=3.20-currentWaterLevel();
    document.getElementById('comparison-freeboard').textContent=selected.section18Comparable===false ? '操作峰非1K+600，無法套算' : freeboard.toFixed(2)+'m'+(freeboard<.5?'（未達0.50m）':'')+(selected.levelQuality==='SCREENING_ESTIMATE'?'／估':'');
    document.getElementById('comparison-quality').textContent=raw.comparableConstructionCases===false ? '750前：通洪外推；後：操作演算。不可直接相減。' : '同斷面報告水位比較；本次Y不是報告全區總數。滑桿偏移不納入前後基準比較。';
  }

  function updateScenarioPresentation() {
    const level = currentWaterLevel();
    const scenario = currentScenario();
    const wraVisual = false; // 使用者要求移除水利署潛勢參考；歷史原始檔不刪除。
    rebuildFlood();
    let detailAtRisk = 0;
    let regionalAtRisk = 0;
    let wraAtRisk = 0;
    let maxDepth = 0;
    if (regionalBuildingMesh && state.buildingSource !== "official") {
      const color = new THREE.Color();
      const riskColor = new THREE.Color();
      const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
      let firstAffectedRegionalIndex = null;
      contextBuildings.forEach((building, index) => {
        const floodState = state.analysisScope === "regional"
          ? buildingFloodState(building, activeFloodCells, level, state.analysisScope)
          : { connected: false, depth: 0, visualDepth: 0 };
        const depth = floodState.depth;
        const affected = depth > 0;
        const wraAffected = wraVisual && hasWraPotential(building);
        const normalColor = state.renderMode === "white" ? "#eceeea" : building.facadeColor;
        const risk = riskForDepth(depth);
        regionalBuildingMesh.setColorAt(index, affected
          ? riskVisualColor(color.set(normalColor), risk, floodState.visualDepth, riskColor)
          : wraAffected && state.renderMode !== "white" ? color.set("#f59e0b") : color.set(normalColor));
        if (regionalRiskOverlayMesh) {
          regionalRiskOverlayMesh.setMatrixAt(index, affected ? regionalBuildingMatrices[index] : hiddenMatrix);
          regionalRiskOverlayMesh.setColorAt(index, affected ? riskColors[risk] : riskColors["低"]);
        }
        if (affected) {
          regionalAtRisk += 1;
          if (firstAffectedRegionalIndex === null) firstAffectedRegionalIndex = index;
        }
        if (wraAffected) wraAtRisk += 1;
        maxDepth = Math.max(maxDepth, depth);
      });
      if (regionalBuildingMesh.instanceColor) regionalBuildingMesh.instanceColor.needsUpdate = true;
      regionalBuildingMesh.material.needsUpdate = true;
      if (regionalRiskOverlayMesh) {
        regionalRiskOverlayMesh.instanceMatrix.needsUpdate = true;
        if (regionalRiskOverlayMesh.instanceColor) regionalRiskOverlayMesh.instanceColor.needsUpdate = true;
      }
      window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
        firstAffectedRegionalInstanceId: firstAffectedRegionalIndex,
        firstAffectedRegionalBuildingId: firstAffectedRegionalIndex === null
          ? null : contextBuildings[firstAffectedRegionalIndex]?.id,
      });
    }
    buildingObjects.forEach(({ body, roof, riskBand, building }) => {
      if (state.buildingSource === "official") return;
      const floodState = buildingFloodState(building, activeFloodCells, level, state.analysisScope);
      const depth = floodState.depth;
      const affected = depth > 0;
      const wraAffected = wraVisual && hasWraPotential(building);
      const risk = riskForDepth(depth);
      riskBand.visible = affected;
      const riskColor = riskVisualColor(body.userData.baseColor, risk, floodState.visualDepth);
      const roofRiskColor = riskVisualColor(roof.userData.baseColor, risk, floodState.visualDepth).offsetHSL(0, 0, -0.08);
      riskBand.material.color.copy(riskColors[risk]);
      riskBand.material.opacity = affected ? THREE.MathUtils.clamp(0.84 + floodState.visualDepth * 0.10, 0.84, 0.96) : 0;
      riskBand.material.needsUpdate = true;
      body.material.color.copy(affected ? riskColor : (wraAffected && state.renderMode !== "white" ? new THREE.Color("#f59e0b") : body.userData.baseColor));
      roof.material.color.copy(affected ? roofRiskColor : (wraAffected && state.renderMode !== "white" ? new THREE.Color("#fbbf24") : roof.userData.baseColor));
      body.material.emissive.copy(affected ? riskColor.clone().multiplyScalar(0.36) : new THREE.Color("#000000"));
      roof.material.emissive.copy(affected ? roofRiskColor.clone().multiplyScalar(0.30) : new THREE.Color("#000000"));
      body.material.needsUpdate = true;
      roof.material.needsUpdate = true;
      if (depth > 0) detailAtRisk += 1;
      if (wraAffected) wraAtRisk += 1;
      maxDepth = Math.max(maxDepth, depth);
    });
    if (state.buildingSource === "official") {
      regionalAtRisk = 0; detailAtRisk = 0; maxDepth = 0; wraAtRisk = 0;
      officialBuildings?.records.forEach(({building, mesh}) => {
        const fixed=buildingCensus.records.get(building.id)?.building;
        const result = fixed ? buildingFloodState(fixed) : {depth:0,visualDepth:0};
        const risk = riskForDepth(result.depth);
        mesh.visible = fullCensusActive() || cellInsideScope(building.e, building.n, state.analysisScope);
        mesh.material.color.copy(result.depth > 0
          ? new THREE.Color("#ffffff").lerp(riskColors[risk], THREE.MathUtils.clamp(0.25 + result.visualDepth * 0.6, 0.25, 1))
          : new THREE.Color("#ffffff"));
        mesh.userData.riskDepth = result.depth;
      });
      buildingsForScope().forEach(({building}) => {
        const result = buildingFloodState(building);
        if (result.depth > 0) regionalAtRisk++;
        maxDepth = Math.max(maxDepth, result.depth);
      });
    }
    officialBuildings?.flushColors();
    const atRisk = detailAtRisk + regionalAtRisk;
    const totalBuildings = buildingsForScope().length;
    document.getElementById("metric-level").textContent = `EL ${level.toFixed(2)} m`;
    document.getElementById("metric-building-label").textContent=fullCensusActive() && buildingCensus.fullManifest.scope.kind==='REPORT_DIGITIZED_REFERENCE' ? '圖面數化參考範圍 X／Y（非正式）' : "報告影響範圍風險 X／Y｜點擊看定義";
    const noOverflow=reportedNoOvertopping(scenario,level);
    document.getElementById("metric-buildings").textContent=totalBuildings ? `${atRisk.toLocaleString("zh-TW")}／${totalBuildings.toLocaleString("zh-TW")}` : '建立本次清冊中';
    document.getElementById('metric-sample').textContent=totalBuildings ? (state.buildingSource==='official'?'本次可計算的固定建物 X／Y（部分範圍，非報告全區）；鏡頭移動不改變Y。':'舊版衍生模型 X／Y，非NLSC官方3D清冊。')+(noOverflow?'主流無外溢，內水仍待評估。':'') : '等待官方建物載入後自動固定第一批清冊；若連線失敗可重試或匯入已保存清冊。';
    if(fullCensusActive())document.getElementById('metric-sample').textContent=`Y為報告Q10前後聯集 ${buildingCensus.fullManifest.scope.unionAreaHa.toFixed(2)}公頃內固定版本模型物件；X為已知外溢風險，另有${buildingCensus.fullManifest.missingGroundCount}個地面高程待評估。${noOverflow?'主流無外溢不等於內水零風險。':''}`;
    document.getElementById('metric-level-basis').textContent=state.displayFlowCms.toFixed(1)+' cms｜'+scenario.constructionStateLabel+'｜假設流量→代表水位 EL '+level.toFixed(2)+'m；非平均潮位、非全河段同步水面。點擊下方依據查看分段公式與限制。';
    ["export-current","export-matrix"].forEach(id=>{document.getElementById(id).disabled=totalBuildings===0;});
    const actualRed = state.buildingSource === "official" ? Array.from(officialBuildings?.records.values()||[]).filter(({mesh})=>mesh.visible&&mesh.material.color.g<mesh.material.color.r-.02).length : atRisk;
    const metric = document.getElementById("metric-buildings");
    const visibleRisk = state.buildingSource === 'official' ? Array.from(officialBuildings?.records.values()||[]).filter(({mesh})=>mesh.visible&&mesh.userData.riskDepth>0).length : atRisk;
    Object.assign(metric.dataset,{risk:String(atRisk),redRendered:String(actualRed),visibleRisk:String(visibleRisk),denominator:totalBuildings?String(totalBuildings):'unknown',sampleSize:fullCensusActive()?'0':String(totalBuildings),reportScopeStatus:DATA.reportImpactScope.status,source:state.buildingSource,floodCells:String(activeFloodCells.size),riverVisible:String(riverGroup.visible),censusRevision:String(buildingCensus.revision),coverage:fullCensusActive()?'COMPLETE_FIXED_DATASET':'AVAILABLE_OBJECTS_ONLY',assessment:noOverflow?'REPORT_NO_MAIN_CHANNEL_OVERTOPPING':'SCREENING_ONLY'});
    const wraMetric = document.getElementById("metric-wra");
    if (wraMetric) wraMetric.textContent = state.buildingSource === "official" ? "新模型待重疊計算" : state.wraAssessmentReady ? `${wraAtRisk.toLocaleString("zh-TW")} 棟` : "載入中";
    document.getElementById("metric-depth").textContent = totalBuildings ? `${maxDepth.toFixed(2)} m` : "樣本待建立";
    const riskDepths = buildingsForScope().map(({building}) => buildingFloodState(building)).filter(result => !result.unknown && result.depth > 0);
    const meanDepth = riskDepths.length ? riskDepths.reduce((sum,result) => sum + result.depth,0) / riskDepths.length : null;
    document.getElementById('metric-mean-depth').textContent = !totalBuildings ? '樣本待建立' : meanDepth === null ? '不適用（無已知外溢風險建物）' : meanDepth.toFixed(2) + ' m（僅X內已知水深）';
    document.getElementById("water-offset").textContent = `${state.waterOffset >= 0 ? "+" : ""}${state.waterOffset.toFixed(2)} m`;
    state.currentRiskCount = atRisk;
    state.currentRegionalRiskCount = regionalAtRisk;
    state.currentDetailRiskCount = detailAtRisk;
    state.currentMaxDepth = maxDepth;
    state.currentMeanDepth = meanDepth;
    updateEventStatus();
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      activeFloodCellCount: activeFloodCells.size,
      riskBuildingCount: atRisk,
      redRenderedCount: actualRed,
      regionalRedRenderedCount: regionalAtRisk,
      detailRedRenderedCount: detailAtRisk,
      wraReferenceBuildingCount: wraAtRisk,
      wraLayerId: state.wraLayerId,
      constructionState: state.constructionState,
      waterOffset: state.waterOffset,
      waterLevel: level,
      scenarioId: scenario.id,
      peakFlowCms: scenario.peakFlowCms,
      displayFlowCms:state.displayFlowCms, eventHours:state.eventHours, hydraulicQuality:'USER_ASSUMED_SCREENING',
      section: scenario.section,
      buildingSource: state.buildingSource,
      denominator: totalBuildings || null,
      sampleSize: totalBuildings,
      reportScopeStatus: DATA.reportImpactScope.status,
    });
    document.documentElement.style.setProperty("--active-scenario", scenario.color);
    updateImpactComparison();
    document.getElementById('scenario-operating-note').textContent='假設展示：新閘門通洪門檻750 cms；超過才啟動外溢。750不是報告核定最大容量；低地內水另待評估。';
    updateQuickActions();
    updateVerificationPanel();
    updateCensusStatus();
    if (state.selected) showSelection(state.selected.kind, state.selected.data, state.selected.instanceId);
  }

  function createScenarioControls() {
    const yearSelect = document.getElementById("analysis-year");
    DATA.analysisYears.forEach((year) => {
      const option = document.createElement("option");
      option.value = year.id;
      option.textContent = year.label;
      yearSelect.appendChild(option);
    });
    yearSelect.value = state.analysisYearId;
    renderScenarioButtons(state.analysisYearId);
  }

  function renderScenarioButtons(yearId) {
    const list = document.getElementById("scenario-list");
    const year = DATA.analysisYears.find((item) => item.id === yearId);
    if (!year) return;
    state.analysisYearId = yearId;
    list.replaceChildren();
    document.getElementById("analysis-year-note").textContent = `${year.description}｜${year.source}`;
    year.frequencies.forEach((frequency) => {
      const rawScenario = frequency.available
        ? DATA.scenarios.find((item) => item.id === frequency.scenarioId) : null;
      const scenario = resolveScenario(rawScenario) || resolveScenario(rawScenario, 'after');
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scenario-button";
      button.dataset.scenario = scenario ? scenario.id : "";
      button.style.setProperty("--scenario", scenario ? scenario.color : "#789094");
      button.setAttribute("aria-pressed", "false");
      button.disabled = !frequency.available;
      const qualityTag = scenario?.peakQuality === "OFFICIAL_REPORTED" ? "報告Q10" : "推估";
      const summary = scenario ? `${scenario.peakFlowCms.toLocaleString("zh-TW")} cms｜${qualityTag}｜${scenario.constructionState === "before" ? "施作前" : "施作後"}` : frequency.warning;
      const level = scenario ? `EL ${scenario.effectiveLevel.toFixed(2)}${scenario.levelQuality === "SCREENING_ESTIMATE" ? "（估）" : ""}` : "未計算";
      button.innerHTML = `
        <span class="scenario-letter">10</span>
        <span class="scenario-copy"><strong>${escapeHtml(frequency.label || frequency.returnPeriod)}</strong><small>${summary}</small></span>
        <span class="scenario-level">${level}</span>`;
      if (scenario) button.addEventListener("click", () => selectScenario(scenario.id, true, true));
      list.appendChild(button);
    });
    document.querySelectorAll(".scenario-button").forEach((button) => {
      const active = button.dataset.scenario === state.scenarioId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateQuickActions();
  }

  function selectAnalysisYear(yearId, showAdvice = true) {
    const year = DATA.analysisYears.find((item) => item.id === yearId);
    if (!year) return;
    document.getElementById("analysis-year").value = year.id;
    renderScenarioButtons(year.id);
    const currentReturn = currentScenario()?.returnPeriod;
    const preferred = year.frequencies.find((item) => item.available && item.returnPeriod === currentReturn);
    const next = preferred || year.frequencies.find((item) => item.available);
    if (next) selectScenario(next.scenarioId, true, showAdvice);
  }

  function selectAnalysisScope(scope) {
    if (scope !== 'regional') return;
    stopFloodAnimation();
    state.analysisScope = scope;
    document.getElementById("analysis-scope").value = scope;
    document.getElementById("analysis-scope-note").textContent = scope === "regional"
      ? "閘門置中16×16公里／256 km²第一階段篩檢；矩形含海域與集水區外土地，非正式1D／2D成果。"
      : "0.4×0.4公里工程細部；用於閘門、圖說與15棟代表建物查核，不代表下游全部影響。";
    updateScenarioPresentation();
    setCameraView(scope === "regional" ? "regional" : "overview", true);
  }

  function cycleAnalysisYear() {
    const currentIndex = DATA.analysisYears.findIndex((item) => item.id === state.analysisYearId);
    const next = DATA.analysisYears[(currentIndex + 1) % DATA.analysisYears.length];
    if (next) selectAnalysisYear(next.id, true);
  }

  function selectQuickReturnPeriod(returnPeriod) {
    const year = DATA.analysisYears.find((item) => item.id === state.analysisYearId);
    const frequency = year?.frequencies.find((item) => item.scenarioId === (state.analysisYearId === 'TARGET_2070' ? 'TARGET2070_Q10' : 'BASE2020_Q10') && item.available);
    if (frequency) selectScenario(frequency.scenarioId, true, true);
  }

  function updateQuickActions() {
    const scenario = currentScenario();
    const year = DATA.analysisYears.find((item) => item.id === state.analysisYearId);
    document.querySelectorAll("[data-quick-return]").forEach((button) => {
      const frequency = year?.frequencies.find((item) => item.returnPeriod === button.dataset.quickReturn);
      button.disabled = !frequency?.available;
      button.classList.toggle("active", ['BASE2020_Q10', 'TARGET2070_Q10'].includes(scenario?.id));
    });
    document.querySelectorAll('[data-quick-scenario]').forEach(button => {
      button.classList.toggle('active', button.dataset.quickScenario === state.scenarioId);
      button.setAttribute('aria-pressed', String(button.dataset.quickScenario === state.scenarioId));
    });
    document.querySelectorAll(".quick-action-button[data-view]").forEach((button) => {
      button.classList.toggle("active", state.cameraView === button.dataset.view);
    });
    const play = document.getElementById("quick-water-play");
    if (play) {
      play.textContent = state.floodAnimation.playing ? "Ⅱ" : "▶";
      play.classList.toggle("playing", state.floodAnimation.playing || state.floodAnimation.paused);
      play.setAttribute("aria-label", state.floodAnimation.playing ? "暫停強降雨情景" : "播放強降雨情景（假設）");
    }
    document.querySelectorAll("[data-construction-state]").forEach((button) => {
      button.disabled = !supportsConstruction(rawScenarioById(state.scenarioId), button.dataset.constructionState);
      button.title = button.disabled ? rawScenarioById(state.scenarioId).comparisonUnavailableReason : (button.dataset.constructionState === 'before' ? '工程施作前／既有閘門' : '工程施作後／改善閘門');
      button.classList.toggle("active", button.dataset.constructionState === state.constructionState);
    });
    const freeButton = document.getElementById("quick-free-explore");
    if (freeButton) freeButton.classList.toggle("active", state.freeExplore);
    const freeExit = document.getElementById("quick-free-exit");
    if (freeExit) {
      freeExit.disabled = !state.freeExplore;
      freeExit.classList.toggle("active", state.freeExplore);
    }
  }

  function openVerificationModal() {
    const select = document.getElementById("verify-water-delta");
    const available = Array.from(select.options, (option) => Number(option.value));
    const nearest = available.reduce((best, value) => Math.abs(value - state.waterOffset) < Math.abs(best - state.waterOffset) ? value : best, available[0]);
    select.value = String(nearest);
    updateVerificationPanel();
    document.getElementById("verification-modal").hidden = false;
    document.getElementById("close-verification").focus();
  }

  function closeVerificationModal() {
    document.getElementById("verification-modal").hidden = true;
  }

  function updateVerificationPanel() {
    const container = document.getElementById("verification-status");
    if (!container) return;
    const scenario = currentScenario();
    const peakOfficial = scenario.peakQuality === "OFFICIAL_REPORTED";
    const levelOfficial = scenario.levelQuality === "OFFICIAL_REPORTED";
    const official = peakOfficial && levelOfficial;
    const qualityText = `${peakOfficial ? "洪峰報告列值" : "洪峰公式推估"}／${levelOfficial ? "水位報告列值" : "水位篩檢推估"}`;
    const statusCards = [
      [official ? "pass" : "warn", "來源一致性", official ? "洪峰與工程前後水位可追溯至基本設計表列" : "至少一項為明示公式推估，非核定頻率／水理成果"],
      ["warn", "可重現性", "待取得水文計算表及HEC-RAS／SEC-HY21原始模型"],
      ["warn", "歷史校正", "尚未取得觀測流量、水位及高水痕誤差指標"],
      ["warn", "敏感度", "目前僅提供靜態水位情境篩檢"],
      ["warn", "資料時效", "主要斷面為民國108年、規劃水文為民國109年成果"],
    ];
    container.innerHTML = statusCards.map(([status, title, note]) => `<article class="${status}"><strong>${title}</strong><span>${note}</span></article>`).join("");
    document.getElementById("verify-scenario").textContent = `${scenario.name}｜${scenario.peakFlowCms.toLocaleString("zh-TW")} cms｜${qualityText}`;
    document.getElementById("verify-construction").textContent = `${scenario.constructionStateLabel}｜${scenario.gateCondition}`;
    document.getElementById("verify-peak-formula").textContent = `${scenario.peakFormula}；${scenario.peakBasis}`;
    document.getElementById("verify-level-basis").textContent = `${scenario.levelBasis}；公式：${scenario.levelFormula}`;
    document.getElementById("verify-gate-discharge").textContent = scenario.gateDischargeBasis;
    document.getElementById("verify-source").textContent = scenario.source;
    const hydraulicBoundary = scenario.boundaryNote || (scenario.analysisYear === "2070"
      ? "表4-14採外水位EL2.66m；SEC-HY21局部河防安全評估另採EL2.0m，兩者不得混用。"
      : "基本設計輸洪檢討採外水位EL2.66m；本網頁為河道連通式靜態篩檢。" );
    const scopeBoundary = state.analysisScope === "regional"
      ? `目前計算閘門置中16×16公里／256km²及${(contextBuildings.length + DATA.buildings.length).toLocaleString("zh-TW")}棟模型建物；矩形含海域與集水區外範圍。`
      : "目前只計算0.4×0.4公里工程細部及15棟代表建物。";
    document.getElementById("verify-boundary").textContent = `${hydraulicBoundary} ${scopeBoundary}`;

    const flowFactor = Number(document.getElementById("verify-flow-factor").value || 0);
    const waterDelta = Number(document.getElementById("verify-water-delta").value || 0);
    const trialFlow = scenario.peakFlowCms * (1 + flowFactor);
    const trialLevel = scenario.effectiveLevel + waterDelta;
    const freeboard = 3.20 - trialLevel;
    const requiredRaise = Math.max(0, 0.5 - freeboard);
    const applied = Math.abs(waterDelta - state.waterOffset) < 0.001;
    document.getElementById("verify-flow").textContent = `${trialFlow.toFixed(0)} cms`;
    document.getElementById("verify-level").textContent = `EL ${trialLevel.toFixed(2)}m`;
    document.getElementById("verify-freeboard").textContent = scenario.section18Comparable === false ? '非同斷面，未計算' : `${freeboard.toFixed(2)}m`;
    document.getElementById("verify-raise").textContent = scenario.section18Comparable === false ? '須補斷面水位' : `${Math.ceil(requiredRaise * 100)}cm`;
    document.getElementById("verify-risk-count").textContent = applied ? `${state.currentRiskCount.toLocaleString("zh-TW")}棟` : "套用後計算";
  }

  function applyVerificationWater() {
    const delta = Number(document.getElementById("verify-water-delta").value || 0);
    setWaterOffset(delta, true);
  }

  function resetVerificationWater() {
    document.getElementById("verify-water-delta").value = "0";
    document.getElementById("verify-flow-factor").value = "0";
    setWaterOffset(0, true);
  }

  function openAdviceModal(scenario = currentScenario()) {
    const quality = `${scenario.peakQuality === "OFFICIAL_REPORTED" ? "洪峰為報告Q10" : "洪峰為公式篩檢推估"}；${scenario.levelQuality === "OFFICIAL_REPORTED" ? "水位為報告列值" : "水位為線性篩檢推估"}`;
    document.getElementById("advice-scenario").textContent = `${scenario.name}｜${scenario.constructionStateLabel}｜${scenario.peakFlowCms.toLocaleString("zh-TW")} cms｜EL ${scenario.effectiveLevel.toFixed(2)} m`;
    document.getElementById("advice-basis").textContent = `${scenario.peakFormula}；${scenario.levelBasis}`;
    document.getElementById("advice-quality").textContent = quality;
    document.getElementById("audit-advice").replaceChildren(...scenario.auditRecommendations.map(adviceListItem));
    document.getElementById("hydraulic-advice").replaceChildren(...scenario.hydraulicRecommendations.map(adviceListItem));
    document.getElementById("advice-source").textContent = `數據依據：${scenario.source}。建議為本模型依基本設計與核心分析報告整理之決策支援，不取代主管機關核定、技師簽證或正式水理分析。`;
    document.getElementById("advice-modal").hidden = false;
    document.getElementById("close-advice").focus();
  }

  function adviceListItem(text) {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }

  function closeAdviceModal() {
    document.getElementById("advice-modal").hidden = true;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character]);
  }

  function sourceLink(url) {
    if (!url) return "—";
    if (!/^https?:\/\//.test(url)) return escapeHtml(url);
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
  }

  function setDetailSourceLinks(links = []) {
    const container = document.getElementById("detail-source-links");
    const anchors = links
      .filter((item) => item && /^https?:\/\//.test(item.url || ""))
      .map((item) => {
        const anchor = document.createElement("a");
        anchor.href = item.url;
        anchor.target = "_blank";
        anchor.rel = "noopener";
        anchor.textContent = item.label;
        return anchor;
      });
    container.replaceChildren(...anchors);
  }

  function buildingPublicInfo(data) {
    const registry = window.WUJIE_BUILDING_PUBLIC_INFO;
    if (!registry || !registry.modelBuildingIds.includes(data.id)) return null;
    return { ...registry.defaultRecord, checkedDate: registry.checkedDate, sources: registry.officialSources };
  }

  function openObjectModal() {
    if (!state.selected) return;
    document.getElementById("object-modal-title").textContent = document.getElementById("info-title").textContent;
    document.getElementById("object-modal").hidden = false;
    document.getElementById("close-object-modal").focus();
  }

  function closeObjectModal() {
    document.getElementById("object-modal").hidden = true;
  }

  function openKnowledgeModal(title, eyebrow, html) {
    document.getElementById("knowledge-title").textContent = title;
    document.getElementById("knowledge-eyebrow").textContent = eyebrow;
    document.getElementById("knowledge-content").innerHTML = html;
    document.getElementById("knowledge-modal").hidden = false;
    document.getElementById("close-knowledge").focus();
  }

  function closeKnowledgeModal() {
    document.getElementById("knowledge-modal").hidden = true;
  }

  function openReviewScope() {
    if(fullCensusActive()){openOfflineCensusDetails();return;}
    const decision = REGIONAL.reviewExtent;
    const official = state.buildingSource === "official";
    const census = official ? `固定樣本內依BUILD_ID去重且在檢討範圍內的${buildingsForScope().length.toLocaleString("zh-TW")}個官方3D模型；不代表全區總數` : `${(contextBuildings.length + DATA.buildings.length).toLocaleString("zh-TW")}個舊版衍生模型（跨LOD去重）`;
    const tiers = decision.tiers.map((tier) => `
      <article class="knowledge-card"><h3>${escapeHtml(tier.name)}</h3><dl>
        <dt>採用範圍</dt><dd>${escapeHtml(tier.scope)}</dd><dt>用途</dt><dd>${escapeHtml(tier.purpose)}</dd>
      </dl></article>`).join("");
    const sources = decision.officialBasis.map((item) => `
      <article class="knowledge-card"><h3>${escapeHtml(item.title)}</h3><dl>
        <dt>判定依據</dt><dd>${escapeHtml(item.finding)}</dd><dt>來源</dt><dd>${sourceLink(item.url)}</dd>
      </dl></article>`).join("");
    openKnowledgeModal("淹水檢討範圍判定", "FLOOD REVIEW EXTENT", `
      <p class="knowledge-intro">原0.16 km²只保留為工程細部。本版把五結閘門設為資料範圍幾何中心，向四向各擴8公里成16×16公里／256 km²，建物口徑為${census}；正式水理模式仍須以110.52 km²集水區、支流、抽排系統與海域邊界建模。</p>
      <div class="knowledge-warning">${escapeHtml(decision.warning)}</div>
      <div class="knowledge-card"><h3>展示樣本與正式Y分開</h3><dl><dt>去重規則</dt><dd>${escapeHtml(official ? "官方BUILD_ID去重；固定樣本比較，不隨視角改分母，尚未完成全區涵蓋率普查" : DEDUP.rule || "跨LOD空間去重")}</dd><dt>去重後風險建物（模型物件）數</dt><dd>${escapeHtml(census)}</dd><dt>正式Y範圍依據</dt><dd>圖8-11與8-12的Q10淹水範圍聯集（原始空間檔待取得），不採256平方公里矩形或概化紅線；詳見X/Y說明。</dd></dl></div>
      <div class="knowledge-grid">${tiers}${sources}</div>`);
  }

  function openRiskStatistics() {
    if(fullCensusActive()){openOfflineCensusDetails();return;}
    const scope=DATA.reportImpactScope,scenario=currentScenario(),n=buildingsForScope().length;
    const available=currentCalculationScope(),box=available.centroidBounds;
    const boundsText=box?`E ${box.xmin.toFixed(2)}～${box.xmax.toFixed(2)}；N ${box.ymin.toFixed(2)}～${box.ymax.toFixed(2)}（公尺）`:'尚未取得建物';
    const required=scope.requiredDocuments.map(item=>'<li><strong>'+escapeHtml(item.agency)+'</strong>：'+escapeHtml(item.documents)+'</li>').join('');
    openKnowledgeModal('報告影響範圍與本次計算：X／Y 定義','REPORT / CURRENT CALCULATION',`
      <div class="knowledge-warning">目前顯示 X=${state.currentRiskCount.toLocaleString('zh-TW')}／Y=${n.toLocaleString('zh-TW')}，只計本次可取得並固定的建物集合，不代表報告全區。完整報告範圍的建物總數與風險數尚待補件；不能用本次比例外推全區。</div>
      <div class="knowledge-grid">
      <article class="knowledge-card"><h3>目前模型實際計算的範圍</h3><dl>
      <dt>計算母體</dt><dd>所選${state.analysisScope==='regional'?'16×16公里展示矩形':'0.4×0.4公里工程細部'}內，已取得並固定的${n.toLocaleString('zh-TW')}個建物模型；按NLSC BUILD_ID去重，不是戶數。並未完成所選矩形內全部建物盤點。</dd>
      <dt>建物位置分布（TWD97／EPSG:3826）</dt><dd>${boundsText}</dd>
      <dt>中心點外包矩形</dt><dd>${available.centroidEnvelopeHa.toFixed(4)}公頃；僅為上述建物分布的包圍框，框內空隙及未取得建物不納入Y，不是淹水影響面積。</dd>
      <dt>建物投影所涉格網</dt><dd>${available.buildingProjectionGridCells}格，${available.gridSizeM}m格網合計${available.buildingProjectionGridHa.toFixed(4)}公頃；是建物投影所接觸的格網集合，不是建物實際占地或淹水面積。</dd>
      <dt>固定日期／版本</dt><dd>${escapeHtml(available.capturedAt||'尚未固定')}／第${available.revision}版；原始圖磚網址及模型日期逐筆保存於清冊。</dd>
      <dt>與報告範圍的關係</dt><dd>尚缺原始淹水邊界，無法確認每筆是否位於報告淹水斑塊內。因此本次集合不是經確認的報告範圍子集，也不宣稱涵蓋率。</dd></dl>
      <p>Y固定後不隨鏡頭或750／775／1088情境改變；只有主動擴充／匯入清冊或切换檢討範圍才重新界定。新鏡頭取得、尚未納入清冊的建物維持白色；可由工具列「擴充本次清冊」納入後重新計算。</p></article>
      <article class="knowledge-card"><h3>報告載明的範圍大小</h3><dl>
      <dt>改建前Q10（圖8-11）</dt><dd>1,517.44公頃＝15.1744平方公里</dd>
      <dt>改建後Q10（圖8-12）</dt><dd>1,141.60公頃＝11.416平方公里</dd>
      <dt>報告改善面積</dt><dd>375.84公頃；不是建物數差，也不是圓形半徑。</dd>
      <dt>區域界定</dt><dd>${escapeHtml(scope.geography)}</dd>
      <dt>統計門檻</dt><dd>${escapeHtml(scope.areaMethod)}</dd>
      <dt>來源</dt><dd>${escapeHtml(scope.report+'；'+scope.sourcePages)}</dd></dl></article>
      <article class="knowledge-card"><h3>完整報告範圍：後續要達成的統計</h3><p>${escapeHtml(scope.boundaryDefinition)}</p><p>${escapeHtml(scope.denominatorDefinition)}</p>
      <p>聯集實際面積待原始圖資計算；不能逕將改建後視為改建前的子集，也不能直接將兩面積相加。切換工程前後仍使用相同S、相同Y。</p>
      <p>模型16×16公里／256平方公里只為展示；110.52平方公里是冬山河集水區，兩者都不是這個淹水影響範圍。</p></article>
      <article class="knowledge-card"><h3>X：同一範圍內的情境風險</h3><p>${escapeHtml(scope.numeratorDefinition)}</p>
      <p>所選${scenario.peakFlowCms} cms／${escapeHtml(scenario.constructionStateLabel)}，水位EL${currentWaterLevel().toFixed(2)}m。暫行條件為建物量體投影與河道連通水格相交且水位高於DTM地面；不等同實際戶數、住戶安全或淹水發生時間。</p>
      <p>750施作後基準無主流外溢是報告敘述，低地內水仍未知。報告Q10範圍作共同查核母體，不冒充750或2070各自正式影響線。</p></article>
      <article class="knowledge-card"><h3>本次X與紅色如何對帳</h3><p>X=${state.currentRiskCount.toLocaleString('zh-TW')}是本次Y之中，投影與當前連通淹水格網相交且水位高於地面的模型數；同一判定控制白色逐漸轉紅。不讀取螢幕像素來計數，故離開鏡頭仍保留統計。</p>
      <p>目前載入且符合顯示條件的染紅物件${escapeHtml(document.getElementById('metric-buildings').dataset.redRendered)}個；未載入或被視角遮擋的模型仍可在清冊X中。X只表示此粗格網篩檢，非實際受災戶數。CSV分開列「本次計算X/Y」及「報告全區X/Y待核算」，最後列資料來源與出處。</p></article></div>
      <h3>完成正式Y尚需哪些資料</h3><ul>${required}</ul>
      <p><a href="data/report_impact_scope.json" target="_blank" rel="noopener">檢視範圍定義、面積與補件清單 JSON</a></p>
      <p>完整流程：取得前後淹水網格/向量→保留孔洞與斑塊並求聯集→官方3D水平投影正面積相交→BUILD_ID跨LOD去重→核對清冊完整性後發布X/Y。現有紅線僅概化參考，不能通過此關卡。</p>`);
  }

  function openHydraulicBasis() {
    const rows = DATA.scenarios.map(raw => {
      const before = resolveScenario(raw, 'before');
      const after = resolveScenario(raw, 'after');
      const cell = s => !s ? '未提供同工況成果' : 'EL ' + s.effectiveLevel.toFixed(2) + 'm（'+escapeHtml(levelQualityLabel(s.levelQuality))+'）<br><small>' + escapeHtml(s.section)+'<br>'+escapeHtml(s.levelFormula)+'<br>'+escapeHtml(s.levelBasis) + '</small>';
      return '<tr><td>' + escapeHtml(raw.name) + '</td><td>' + raw.peakFlowCms + '</td><td>' + cell(before) + '</td><td>' + cell(after) + '</td><td>' + escapeHtml(raw.source) + '</td></tr>';
    }).join('');
    const selected = currentScenario();
    openKnowledgeModal('Q10各流量口徑、河道輸洪與閘門操作依據', 'HYDRAULIC BASIS',
      '<div class="knowledge-warning">洪峰Q是需要排除的來水量，不是閘門容量。775→1088 cms在相同外水與改善工程條件下，1K+600報告水位由2.79升為2.92m。改善效益要以同一Q比較前後，不可把高Q誤認為較安全。</div><p>展示水位＝所選情境代表洪水位＋動畫/手動偏移；不是冬山河平均漲潮水位，也不是全河段各處實際同一水位。感潮河段需逐時外水、內水及閘門操作歷線。<a href="https://www.hec.usace.army.mil/confluence/rasdocs/ras1dtechref/latest/theoretical-basis-for-one-dimensional-and-two-dimensional-hydrodynamic-calculations/1d-unsteady-flow-hydrodynamics/implicit-finite-difference-scheme/downstream-boundary-conditions" target="_blank" rel="noopener">USACE HEC-RAS下游邊界官方說明</a>；該文支持方法限制，不是本案2.89m的官方核定。</p><p class="knowledge-intro">750 cms是高地來水的關閘禦潮／洩水操作工況；775 cms是一般治理設計基準。兩者水位位置與邊界不同，不能用水位高低直接判定哪個方案較安全。</p>' +
      '<div class="definition-table-wrap"><table class="definition-table"><thead><tr><th>Q10工況</th><th>洪峰cms</th><th>工程施作前水位</th><th>工程施作後水位</th><th>出處</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="knowledge-grid"><article class="knowledge-card"><h3>目前所選情境</h3><p>' + escapeHtml(selected.name) + '</p><dl><dt>洪峰</dt><dd>' + escapeHtml(selected.peakFormula) + '</dd><dt>水位</dt><dd>' + escapeHtml(selected.levelBasis) + '</dd><dt>水位公式／取值</dt><dd>' + escapeHtml(selected.levelFormula) + '</dd><dt>操作</dt><dd>' + escapeHtml(selected.gateCondition) + '</dd><dt>排洪量</dt><dd>' + escapeHtml(selected.gateDischargeBasis) + '</dd></dl></article>' +
      '<article class="knowledge-card"><h3>750 cms關閘禦潮</h3><p>常水位EL1.0m；關閘約6小時，後續固定開度洩水約18小時。內水高於外水0.3m且外水下降時，6門以1.5m開度洩水。兩岸抽水站合計減排25 cms。</p><p>全閉閘門通流為0；表8-5出流峰816 cms是洩水歷程峰值。最高內水EL2.46m與外水峰EL2.66m非同時；外水峰時內水為EL1.58m。</p><p>來源：基本設計第3-22頁、第8-6～8-7頁圖8-2、第8-10頁表8-5。既有閘門750 cms另以表4-13與4-14同斷面資料外推EL2.89m，一般通洪與操作峰不可直接比較效益；低地積淹與退水時間仍待原始模式。</p></article>' +
      '<article class="knowledge-card"><h3>775 cms一般治理</h3><p>表4-13斷面18／1K+600：工程前EL2.91m、工程後EL2.79m，下降0.12m。相對堤頂EL3.20m出水高0.29／0.41m；與0.50m原則差0.21／0.09m，僅為該斷面算術檢討。</p><p>僅保留750、775及目標年1,088 cms。775及1,088 cms採報告斷面列值；出水高不足不等於水位已超過堤頂，也不代表周邊必然淹水。750施作後操作峰不套用通洪內插式；施作前EL2.89m另為一般通洪外推假設，不能與操作峰直接比較。</p></article></div>' +
      '<div class="knowledge-warning">本網站以報告水位作連通式靜態篩檢；動畫不是逐時關閘模擬。風險計數未完整計入低地抽排減量、堤防阻水與潮汐歷程，不能據此認定實際安全、淹水時間或正式減災棟數。</div>');
  }

  function openGovernmentData() {
    const registry = window.WUJIE_PUBLIC_DATA_CATALOG;
    if (!registry || !Array.isArray(registry.assets)) {
      openKnowledgeModal("政府公開資料清冊", "GOVERNMENT DATA", "<div class=\"knowledge-warning\">內嵌清冊不存在，請重新載入本頁。</div>");
      return;
    }
    const cards = registry.assets.map((asset) => `
      <article class="knowledge-card"><h3>${escapeHtml(asset.title)}</h3><dl>
        <dt>資料分類</dt><dd>${escapeHtml(asset.category || "—")}</dd>
        <dt>主管／產製機關</dt><dd>${escapeHtml(asset.agency)}</dd>
        <dt>圖層定義／實際用途</dt><dd>${escapeHtml(asset.definition || "—")}</dd>
        <dt>資料年份／版本</dt><dd>${escapeHtml(asset.dataYear || "來源未標示")}</dd>
        <dt>更新頻率／取得日期</dt><dd>${escapeHtml(asset.updatedOrRetrieved || "—")}</dd>
        <dt>座標／解析度</dt><dd>${escapeHtml(asset.crsResolution || "—")}</dd>
        <dt>正式資料頁</dt><dd>${sourceLink(asset.sourceUrl)}</dd>
        <dt>圖層／下載服務</dt><dd>${asset.serviceUrl ? sourceLink(asset.serviceUrl) : "—"}</dd>
        <dt>本模型使用狀態</dt><dd>${escapeHtml(asset.status || "—")}</dd>
        <dt>限制</dt><dd>${escapeHtml(asset.limitation || "—")}</dd>
      </dl></article>`).join("");
    openKnowledgeModal("政府公開資料清冊", "GOVERNMENT DATA", `
      <p class="knowledge-intro">${registry.assets.length}筆來源登錄（含歷史資料）；清冊查核日期${escapeHtml(registry.checkedDate)}。</p>
      <div class="knowledge-warning">本版已移除水利署潛勢參考功能。歷史潛勢檔不參與本版計算；僅保留原始研究紀錄。</div>
      <div class="knowledge-grid">${cards}</div>`);
  }

  function openModelNotes() {
    const limitations = [...(REGIONAL.limitations || []), ...(DATA.limitations || [])];
    const hydro = REGIONAL.hydrography || {};
    openKnowledgeModal("限制與模型說明", "MODEL NOTES", `
      <p class="knowledge-warning">${escapeHtml(FLOW.explanation)}</p><p class="knowledge-intro">本版預設使用NLSC官方3D按需載入；統計為使用者固定樣本，非全區清冊。資料矩形固定16×16公里／256 km²，靠近工程使用閘門視角或縮放；原衍生量體僅保留為離線備援。降雨與水波紋為視覺示意，不參與流量或淹水量計算。</p>
      <div class="knowledge-warning">256 km²矩形涵蓋設計報告圖面之下游低地包絡，但也含海域、山地與集水區外範圍。淹水結果仍是河道連通式靜態水位概估，不是官方2D水理重算；紅線為PDF圖面概化，施工期情境亦不代表施工計畫承諾。水利署淹水潛勢參考功能已依使用者要求移除，歷史檔不再參與計算；正式風險仍須以同一集水區邊界、閘門、抽水站與細網格1D／2D模式校核。</div>
      <div class="knowledge-grid"><article class="knowledge-card"><h3>河道定位：待校正（非通過）</h3><p>舊模型由EMAP5影像色類別、40m格網、人工中心線320m走廊及3×3閉合運算產生。這會概化河岸並可能連上鄰近水體；並非NLSC河川面向量。舊100%一致率只是與同來源水域格網互相比對，不能證明與PHOTO2獨立一致。</p><p>本次將參考河道面與淹水層分離、固定貼近地形，且預設隱藏；並未據此宣稱真實河岸已完成修正。</p><p>${sourceLink('https://maps.nlsc.gov.tw/S09SOA/pro/Wfs_ajax_main.jsp')}：EMAP_RIVERA／RIVERL／WATERA需申請。${sourceLink('https://data.gov.tw/dataset/25781')}：另有水利署開放河道SHP，但目錄標示統計年度2000，尚未代入，不能當作最新河岸。</p></article></div>
      <div class="knowledge-grid">${limitations.map((item, index) => `<article class="knowledge-card"><h3>限制 ${index + 1}</h3><div>${escapeHtml(item)}</div></article>`).join("")}</div>`);
  }

  function wireUi() {
    document.getElementById("analysis-scope").addEventListener("change", (event) => {
      selectAnalysisScope(event.target.value);
    });
    document.getElementById("analysis-year").addEventListener("change", (event) => {
      selectAnalysisYear(event.target.value, true);
    });
    document.getElementById("construction-state").addEventListener("change", (event) => {
      selectConstructionState(event.target.value, true, true);
    });
    document.getElementById("show-advice").addEventListener("click", () => openAdviceModal());
    document.getElementById("open-verification").addEventListener("click", openVerificationModal);
    document.getElementById("close-verification").addEventListener("click", closeVerificationModal);
    document.getElementById("verification-modal").addEventListener("click", (event) => {
      if (event.target.id === "verification-modal") closeVerificationModal();
    });
    document.getElementById("verify-flow-factor").addEventListener("change", updateVerificationPanel);
    document.getElementById("verify-water-delta").addEventListener("change", updateVerificationPanel);
    document.getElementById("apply-verification-water").addEventListener("click", applyVerificationWater);
    document.getElementById("reset-verification-water").addEventListener("click", resetVerificationWater);
    document.getElementById("export-current").addEventListener("click", exportCurrentRiskBuildings);
    document.getElementById("export-matrix").addEventListener("click", exportFullRiskMatrix);
    document.getElementById("close-advice").addEventListener("click", closeAdviceModal);
    document.getElementById("advice-modal").addEventListener("click", (event) => {
      if (event.target.id === "advice-modal") closeAdviceModal();
    });
    document.getElementById("open-object-info").addEventListener("click", openObjectModal);
    document.getElementById("close-object-modal").addEventListener("click", closeObjectModal);
    document.getElementById("object-modal").addEventListener("click", (event) => {
      if (event.target.id === "object-modal") closeObjectModal();
    });
    document.getElementById("open-review-scope").addEventListener("click", openReviewScope);
    document.getElementById("open-risk-statistics").addEventListener("click", openRiskStatistics);
    document.getElementById("open-hydraulic-basis").addEventListener("click", openHydraulicBasis);
    document.getElementById("open-gov-data").addEventListener("click", openGovernmentData);
    document.getElementById("open-model-notes").addEventListener("click", openModelNotes);
    document.getElementById("close-knowledge").addEventListener("click", closeKnowledgeModal);
    document.getElementById("knowledge-modal").addEventListener("click", (event) => {
      if (event.target.id === "knowledge-modal") closeKnowledgeModal();
    });
    document.getElementById("water-slider").addEventListener("input", (event) => {
      setWaterOffset(Number(event.target.value), true);
    });
    document.getElementById("water-minus").addEventListener("click", () => stepWater(-0.05));
    document.getElementById("water-plus").addEventListener("click", () => stepWater(0.05));
    document.querySelectorAll("[data-quick-return]").forEach((button) => button.addEventListener("click", () => selectQuickReturnPeriod(button.dataset.quickReturn)));
    document.querySelectorAll("[data-construction-state]").forEach((button) => button.addEventListener("click", () => selectConstructionState(button.dataset.constructionState, true, false)));
    document.querySelectorAll('[data-quick-scenario]').forEach(button => button.addEventListener('click', () => selectScenario(button.dataset.quickScenario, true, false)));
    document.getElementById("quick-water-play").addEventListener("click", toggleFloodAnimation);
    document.getElementById("toggle-free-explore").addEventListener("click", () => setFreeExplore(!state.freeExplore));
    document.getElementById("quick-free-explore").addEventListener("click", () => setFreeExplore(true));
    document.getElementById("quick-free-exit").addEventListener("click", () => setFreeExplore(false, true, "quick-exit"));
    document.getElementById("vertical-scale").addEventListener("change", (event) => {
      state.verticalScale = Number(event.target.value);
      worldRoot.scale.y = state.verticalScale;
    });
    document.getElementById("toggle-basemap").addEventListener("change", (event) => {
      applySelectedBasemap();
    });
    document.getElementById("basemap-source").addEventListener("change", (event) => {
      state.basemapSource = event.target.value;
      applySelectedBasemap();
    });
    document.getElementById("render-mode").addEventListener("change", (event) => {
      state.renderMode = event.target.value;
      applyRenderMode();
    });
    document.getElementById("toggle-cadastral").addEventListener("change", (event) => { cadastralGroup.visible = event.target.checked; });
    document.getElementById("toggle-building-reference").addEventListener("change", (event) => { buildingReferenceGroup.visible = event.target.checked; });
    document.getElementById("toggle-drawing").addEventListener("change", (event) => { engineeringDrawingGroup.visible = event.target.checked; });
    document.getElementById("toggle-buildings").addEventListener("change", syncBuildingSource);
    document.getElementById("building-source").addEventListener("change", event => {
      state.buildingSource = event.target.value; syncBuildingSource(); comparisonRiskCache.clear(); updateScenarioPresentation();
    });
    document.getElementById("retry-nlsc-buildings").addEventListener("click", () => officialBuildings?.retry());
    document.getElementById("toggle-building-contours").addEventListener("change",event=>officialBuildings?.setContoursVisible(event.target.checked));
    document.getElementById("capture-building-census").addEventListener("click", captureBuildingCensus);
    document.getElementById("export-building-census").addEventListener("click", () => {
      const snapshot=buildingCensus.snapshot(window.WUJIE_PUBLIC_DATA_CATALOG?.assets||[]);
      const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download=fullCensusActive()?'census.json':'五結_NLSC固定樣本_非全區清冊.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    document.getElementById("import-building-census").addEventListener("change", async event => {
      const file=event.target.files?.[0];if(!file)return;
      try {
        if(file.size>80*1024*1024)throw Error('檔案超過80MB，請先離線檢查。');
        buildingCensus.restore(JSON.parse(await file.text()));
        persistBuildingCensus();
        comparisonRiskCache.clear();updateScenarioPresentation();
      } catch(error) { openKnowledgeModal('固定樣本匯入失敗','CENSUS', '<p>'+escapeHtml(error.message)+'</p>'); }
      event.target.value='';
    });
    document.getElementById("open-offline-census").addEventListener("click",openOfflineCensusDetails);
    document.getElementById("import-offline-package").addEventListener("change",importOfflinePackage);
    document.getElementById("toggle-dikes").addEventListener("change", (event) => { infrastructureGroup.visible = event.target.checked; });
    document.getElementById("toggle-flood").addEventListener("change", (event) => { floodGroup.visible = event.target.checked; });
    document.getElementById("toggle-river-surface").addEventListener("change", event => {
      riverGroup.visible=event.target.checked;
      document.getElementById('metric-buildings').dataset.riverVisible=String(riverGroup.visible);
    });
    document.getElementById("toggle-wra-potential")?.addEventListener("change", (event) => {
      const note = document.getElementById("wra-layer-note");
      if (note) note.textContent = event.target.checked
        ? "橙色＝所選水利署潛勢圖與建物足跡重疊；紅色仍專指本案情境計算之風險。"
        : "水利署潛勢參考已隱藏（建物風險計算仍保留於匯出欄位）。";
    });
    document.getElementById("wra-layer")?.addEventListener("change", (event) => {
      state.wraLayerId = event.target.value;
      updateScenarioPresentation();
    });
    document.getElementById("toggle-labels").addEventListener("change", (event) => {
      state.labels = event.target.checked;
      updateLabels();
    });
    document.getElementById("toggle-wireframe").addEventListener("change", (event) => { wireframeMesh.visible = event.target.checked; });
    document.getElementById("toggle-river-qa").addEventListener("change", (event) => {
      riverQaGroup.visible = event.target.checked;
      window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, { riverQaVisible: riverQaGroup.visible });
    });
    const labelToggleMap = {
      "toggle-label-buildings": "building",
      "toggle-label-roads": "road",
      "toggle-label-engineering": "engineering",
      "toggle-label-rivers": "river",
      "toggle-label-places": "place",
    };
    Object.entries(labelToggleMap).forEach(([toggleId, category]) => {
      document.getElementById(toggleId).addEventListener("change", (event) => {
        state.labelCategories[category] = event.target.checked;
        window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, { labelCategories: { ...state.labelCategories } });
        updateLabels();
      });
    });
    const boundaryToggleMap = {
      "toggle-report-watershed": "report-watershed-clipped",
      "toggle-report-lowland": "report-lowland-envelope",
      "toggle-report-q10-before": "report-q10-before-envelope",
      "toggle-report-q10-after": "report-q10-after-envelope",
    };
    Object.entries(boundaryToggleMap).forEach(([toggleId, boundaryId]) => {
      const toggle = document.getElementById(toggleId);
      const line = reportBoundaryObjects.get(boundaryId);
      if (!toggle || !line) return;
      line.visible = toggle.checked;
      toggle.addEventListener("change", (event) => { line.visible = event.target.checked; });
    });
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setCameraView(button.dataset.view, true)));
    document.getElementById("collapse-controls").addEventListener("click", (event) => {
      document.getElementById("unified-toolbar").classList.add("closed");
      const toggle = document.getElementById("toolbar-toggle");
      toggle.classList.add("visible");
      toggle.setAttribute("aria-expanded", "false");
      event.currentTarget.setAttribute("aria-expanded", "false");
      window.setTimeout(updateResponsiveQa, 280);
    });
    document.getElementById("toolbar-toggle").addEventListener("click", (event) => {
      document.getElementById("unified-toolbar").classList.remove("closed");
      event.currentTarget.classList.remove("visible");
      event.currentTarget.setAttribute("aria-expanded", "true");
      document.getElementById("collapse-controls").setAttribute("aria-expanded", "true");
      window.setTimeout(updateResponsiveQa, 280);
    });

    renderer.domElement.addEventListener("pointerdown", (event) => {
      if (event.button !== 2 || !state.freeExplore) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pointerDown = null;
      setFreeExplore(false, true, "right-click");
      renderer.domElement.style.cursor = "grab";
    }, true);
    renderer.domElement.addEventListener("pointerdown", (event) => {
      pointerDown = event.button === 0
        ? { x: event.clientX, y: event.clientY, button: event.button, pointerId: event.pointerId }
        : null;
    });
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", updateResponsiveQa);
  }

  function applyRenderMode() {
    const white = state.renderMode === "white";
    if (regionalBuildingMesh) {
      const color = new THREE.Color();
      contextBuildings.forEach((building, index) => {
        regionalBuildingMesh.setColorAt(index, color.set(white ? "#eceeea" : building.facadeColor));
      });
      if (regionalBuildingMesh.instanceColor) regionalBuildingMesh.instanceColor.needsUpdate = true;
      regionalBuildingMesh.material.needsUpdate = true;
    }
    buildingObjects.forEach(({ body, roof }) => {
      body.userData.baseColor.copy(white ? new THREE.Color("#eceeea") : body.userData.currentColor);
      roof.userData.baseColor.copy(white ? new THREE.Color("#f5f5f2") : roof.userData.currentColor);
    });
    infrastructureGroup.traverse((object) => {
      if (!object.isMesh || !object.userData.currentColor || !object.material?.color) return;
      const forceWhite = object.userData.renderClass === "design";
      object.material.color.copy(forceWhite || white ? object.userData.whiteColor : object.userData.currentColor);
      object.material.needsUpdate = true;
    });
    updateScenarioPresentation();
  }

  function exportCurrentRiskBuildings() {
    const scenario = currentScenario();
    const level = currentWaterLevel();
    const scenarioFloods = scenarioFloodStates(state.analysisScope);
    const population = buildingsForScope();
    const rows = population.map(({ building, lod }) =>
      riskExportRow(
        building,
        lod,
        scenario,
        level,
        activeFloodCells,
        state.analysisScope,
        activeFloodCellData,
        firstRiskCondition(building, state.analysisScope, scenarioFloods), population.length
      )
    ).filter((row) => row["推估淹水深度（公尺）"] > 0);
    downloadRiskCsv(rows, `五結風險建物_${state.analysisScope}_${scenario.id}_${state.constructionState === "before" ? "工程施作前" : "工程施作後"}_EL${level.toFixed(2)}.csv`);
  }


  function createOfficialBuildings() {
    if (!window.WujieNlsc) return;
    officialBuildings = new WujieNlsc.NlscBuildings({
      center: REGIONAL.center, extent: REGIONAL.terrain.extent, grid: REGIONAL.terrain.extent,
      cell: CELL, datum: DATUM, ground: sampleTerrain,
      onStatus: status => {
        window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, { nlsc3d: status });
        const note = document.getElementById("nlsc-building-status");
        const names = {CONNECTING_ROOT:"連線官方根索引",ROOT_CONNECTED:"已取得根索引，等待可見圖磚",VISIBLE_TILE_RECEIVED:"已收到官方圖磚",PARTIAL:"部分載入／部分失敗",TIMEOUT:"官方服務逾時",FAILED:"官方服務或格式失敗"};
        if(note) note.textContent = (names[status.status]||status.status)+"｜"+status.buildings+"個已載入官方模型／"+status.tiles+"圖磚。最多48片視角周邊圖磚，非全區普查；失敗"+status.failed+"片。"+(officialBuildings?.error||"");
        if(!censusRestorePending&&!buildingCensus.records.size&&status.buildings>0&&status.pending===0&&officialBuildings?.wanted?.size&&Array.from(officialBuildings.wanted).every(url=>officialBuildings.loaded.has(url)||officialBuildings.failed.has(url))){
          clearTimeout(censusCaptureTimer);censusCaptureTimer=setTimeout(()=>{if(!buildingCensus.records.size)captureBuildingCensus();},500);
        }
      },
      onChange: () => {
        if(state.buildingSource === "official") updateScenarioPresentation();
      }
    });
    worldRoot.add(officialBuildings.group);syncBuildingSource();
  }
  function fullCensusActive() {
    return state.buildingSource==='official' && !!buildingCensus.fullManifest;
  }
  function currentCalculationScope(scope=state.analysisScope) {
    const key=buildingCensus.revision+'|'+state.buildingSource+'|'+scope;
    if(!calculationScopeCache.has(key)) {
      calculationScopeCache.clear();calculationScopeCache.set(key,buildingCensus.describe(buildingsForScope(scope)));
    }
    return calculationScopeCache.get(key);
  }
  function censusRiskTotal(cells,level,scope,cellData) {
    let cache=censusRiskCache.get(cells);
    if(!cache){cache=new Map();censusRiskCache.set(cells,cache);}
    const key=level+'|'+scope+'|'+buildingCensus.revision;
    const population=buildingCensus.fullManifest && buildingCensus.records ? Array.from(buildingCensus.records.values()) : buildingsForScope(scope);
    if(!cache.has(key))cache.set(key,population.reduce((n,{building})=>n+(buildingFloodState(building,cells,level,scope,cellData).depth>0?1:0),0));
    return cache.get(key);
  }
  async function importOfflinePackage(event) {
    const input=event.target;if(!input.files.length)return;
    const note=document.getElementById('offline-package-status');
    note.textContent='正在檢查完整清冊、範圍及幾何檔雜湊…';input.disabled=true;
    try {
      const validated=await WujieOfflineCensus.loadFiles(input.files,REGIONAL.terrain.extent,buildingCensus.grid,REGIONAL.center);
      // loadFiles checked both grid geometry and the pinned regional-data fingerprint.
      const replacement=new WujieOfflineCensus.OfflineBuildings(validated);
      if(officialBuildings){
        officialBuildings.enabled=false;officialBuildings.onStatus=null;officialBuildings.onChange=null;
        worldRoot.remove(officialBuildings.group);
        officialBuildings.loaded.forEach(t=>t.meshes.forEach(m=>{m.geometry.dispose();m.material.dispose();}));
      }
      officialBuildings=replacement;buildingCensus.restoreFull(validated);
      worldRoot.add(replacement.group);state.buildingSource='official';
      document.getElementById('building-source').value='official';
      document.querySelector('#building-source option[value="official"]').textContent='NLSC固定版本3D（離線全區白模）';
      selectAnalysisScope('regional');
      document.getElementById('analysis-scope-note').textContent='已固定完整報告影響範圍母體；靠近閘門請使用閘門視角／縮放，不裁切統計Y。';
      document.getElementById('retry-nlsc-buildings').disabled=true;
      officialBuildings.setContoursVisible(document.getElementById('toggle-building-contours').checked);
      document.getElementById('nlsc-building-status').textContent=`離線固定版本 ${validated.manifest.version}｜完整清冊${validated.manifest.count}個模型物件。建物不再連線NLSC；底圖仍依所選來源。`;
      note.textContent='離線資料已套用；移動鏡頭不改變Y。重新開啟網頁需再次匯入同版本兩個檔案。';
      comparisonRiskCache.clear();syncBuildingSource();updateScenarioPresentation();
      document.querySelector('.status-dot').textContent='全區固定清冊已匯入／淹水仍為篩檢';
      openOfflineCensusDetails();
    } catch(error) {
      note.textContent='未套用：'+error.message+'；原模型及統計保留。';
      openKnowledgeModal('離線全區資料匯入未通過','OFFLINE CENSUS','<p>'+escapeHtml(error.message)+'</p><p>不以部分成功筆數冒充全區總數。</p>');
    } finally {input.disabled=false;input.value='';}
  }
  function openOfflineCensusDetails() {
    const m=buildingCensus.fullManifest;
    const result=m ? `<article class="knowledge-card"><h3>固定母體與本情境</h3><dl><dt>Y 全部模型物件</dt><dd>${m.count.toLocaleString('zh-TW')}；依BUILD_ID去重，完整投影與S正面積相交。</dd><dt>X 已知外溢風險</dt><dd>${state.currentRiskCount.toLocaleString('zh-TW')}；目前${currentScenario().peakFlowCms} cms／${escapeHtml(currentScenario().constructionStateLabel)}，水位EL${currentWaterLevel().toFixed(2)}m，建物與連通水格相交且水位高於地面。</dd><dt>U 地面高程待評估</dt><dd>${m.missingGroundCount}；已保留在Y，不視為零風險。</dd><dt>影響範圍S</dt><dd>${m.scope.unionAreaHa.toFixed(4)}公頃；${escapeHtml(m.scope.definition)}</dd><dt>範圍品質</dt><dd>${escapeHtml(m.scope.kind)}；${escapeHtml(m.scope.source)}</dd><dt>版本與對帳</dt><dd>${escapeHtml(m.version)}；檔案${m.audit.filesVerified}、移除重複${m.audit.duplicateRecordsRemoved}、範圍外${m.audit.outsideScopeCount}個。</dd></dl><p>${escapeHtml(m.limitation)}</p><p>750施作後基準主流無溢堤，不代表低地內水安全；報告Q10共同母體不等於750或2070各自的正式淹水線。相機載入與統計母體分離。</p></article>` : '<div class="knowledge-warning">本案已選「固定版本建物資料＋離線統計清冊」。目前尚未收到完整NLSC模型包及報告原始淹水範圍，因此報告全區X／Y待算；首頁已另計「本次可取得範圍X／Y」，請點擊該指標查看實際範圍。既有線上白模保留供核對，並非全區清冊。</div>';
    openKnowledgeModal('全區離線清冊：資料準備與X／Y','OFFLINE FIXED CENSUS',result+`
      <div class="knowledge-grid"><article class="knowledge-card"><h3>範圍依據</h3><p>基本設計表8-9、圖8-11、8-12：改建前1,517.44公頃，改建後1,141.60公頃。共同母體採前後淹水範圍聯集，保留斑塊與孔洞；聯集不能用兩面積直接相加，也不是以閘門畫圓。</p><p>需向宜蘭縣政府水利資源處／設計單位取得原始SOBEK水深網格或淹水面，含坐標、深度門檻及工況。</p></article>
      <article class="knowledge-card"><h3>本次查到的原始檔</h3><p>「五結防潮閘門水理模型.zip」含SEC-HY21 1.59、750 cms定流量與下游EL1.70m設定及場址局部坐標地形點；尚不能當作圖8-11、8-12的SOBEK全區成果。需確認坐標轉換及模型版本，未自行改寫情境水位。</p></article>
      <article class="knowledge-card"><h3>完整NLSC資料需求</h3><p>同一版本的完整分棟3D模型、BUILD_ID、模型日期、LOD、原始屬性、涵蓋面與完整性說明，以及可離線處理／展示的使用條件。免申請線上介接不等同完整實體檔可免費下載。</p><p>${sourceLink('https://www.nlsc.gov.tw/cp.aspx?n=16733')}<br>${sourceLink('https://www.nlsc.gov.tw/cp.aspx?n=1549')}</p></article>
      <article class="knowledge-card"><h3>已完成的匯入流程</h3><p>本地完整3D Tiles索引檢查 → 原始3D投影 → BUILD_ID去重 → 前後範圍聯集裁切 → DTM與水格相交 → 固定清冊與白模。收到合法資料後產出census.json及positions.bin，同時選取即可套用。當前僅支援未壓縮GLB型3D Tiles 1.1；I3S／壓縮格式會明確拒絕，不跳漏。</p><p>白模輪廓、点選資訊與漸進紅色沿用。動畫時間及750／775／1088三種工況不變。此處只完成資料與統計接線，尚非水理驗證。</p></article></div>`);
  }
  function updateCensusStatus() {
    const note=document.getElementById('building-census-status');
    if(note)note.textContent=buildingCensus.records.size
      ? `本次固定清冊${buildingCensus.records.size.toLocaleString('zh-TW')}個（第${buildingCensus.revision}版）；僅為目前可取得部分，非報告全區。切換鏡頭不新增；需要擴充請按下方按鈕。${censusStorageWarning||'已保存在本瀏覽器；可另存JSON供查核／跨網址匯入。'}`
      : '首次成功載入後自動固定本次可取得建物；非全區普查。'+censusStorageWarning;
    document.getElementById('export-building-census').disabled=!buildingCensus.records.size;
    document.getElementById('capture-building-census').disabled=!!buildingCensus.fullManifest||!officialBuildings?.records.size;
    document.getElementById('import-building-census').disabled=!!buildingCensus.fullManifest;
    if(buildingCensus.fullManifest){
      const m=buildingCensus.fullManifest;
      note.textContent=`全區固定清冊 ${m.version}：Y=${m.count.toLocaleString('zh-TW')}個模型物件；${m.scope.unionAreaHa.toFixed(2)}公頃。鏡頭移動不改變Y；高程缺值${m.missingGroundCount}個。`;
      document.getElementById('export-building-census').textContent='保存全區固定清冊JSON';
    }
    document.getElementById('export-current').textContent=fullCensusActive()?'匯出全區已知外溢風險CSV':'匯出本次範圍風險CSV（非全區）';
    document.getElementById('export-matrix').textContent=fullCensusActive()?'匯出全區六組情境矩陣（含未知）':'匯出本次範圍六組情境矩陣';
  }
  function storedCensus(action,value) {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open('wujie-fixed-building-census',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('cohorts');
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('清冊資料庫被其他分頁鎖定'));
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('cohorts',action==='get'?'readonly':'readwrite');
        const store=tx.objectStore('cohorts'),op=action==='get'?store.get(censusStorageKey):store.put(value,censusStorageKey);
        tx.oncomplete=()=>{db.close();resolve(op.result);};
        tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||Error('清冊儲存失敗'));};
      };
    });
  }
  function persistBuildingCensus() {
    censusStorageWarning='正在保存本次清冊，請稍候再關閉頁面。';
    storedCensus('put',buildingCensus.snapshot()).then(()=>{
      censusStorageWarning='';try{localStorage.removeItem(censusStorageKey);}catch{}
      updateCensusStatus();
    }).catch(error=>{censusStorageWarning='瀏覽器儲存未成功，請另存JSON，否則重新開啟會重新建立：'+error.message;updateCensusStatus();});
  }
  function captureBuildingCensus() {
    if(!officialBuildings?.records.size)return;
    buildingCensus.capture(officialBuildings.records);
    persistBuildingCensus();
    comparisonRiskCache.clear();updateScenarioPresentation();
  }
  function syncBuildingSource() {
    const visible = document.getElementById("toggle-buildings").checked;
    const official = state.buildingSource === "official";
    buildingGroup.visible = !official && visible;contextBuildingGroup.visible = !official && visible;
    if(officialBuildings){officialBuildings.enabled=official;officialBuildings.group.visible=official && visible;}
  }
  function currentClickables() {
    return [...clickableMeshes, ...(state.buildingSource === "official" ? officialBuildings?.group.children || [] : [])].filter(isHierarchyVisible);
  }

  function buildingsForScope(scope = state.analysisScope) {
    if (state.buildingSource === "official") {
      const key=buildingCensus.revision+'|'+scope+'|'+fullCensusActive();
      if(!calculationPopulationCache.has(key)){
        calculationPopulationCache.clear();calculationPopulationCache.set(key,Array.from(buildingCensus.records.values()).filter(({building})=>fullCensusActive()||cellInsideScope(building.e,building.n,scope)));
      }
      return calculationPopulationCache.get(key);
    }
    const detailed = DATA.buildings.map((building) => ({ building, lod: "LOD0工程細部" }));
    if (scope === "detail") return detailed;
    return [
      ...contextBuildings.map((building) => ({ building, lod: "LOD1區域篩檢" })),
      ...detailed,
    ];
  }

  function scenarioFloodStates(scope, constructionState = state.constructionState) {
    const cache = new Map();
    DATA.scenarios.forEach((rawScenario) => {
      const scenario = resolveScenario(rawScenario, constructionState);
      if (!scenario) return;
      cache.set(rawScenario.id, {
        scenario,
        flood: computeConnectedFlood(scenario.effectiveLevel, 1, scope, scenario),
      });
    });
    return cache;
  }

  function levelQualityLabel(value) {
    return ({
      OFFICIAL_REPORTED: "基本設計報告正式列值",
      SCREENING_ESTIMATE: "依明示公式計算之篩檢推估值",
    })[value] || value || "未註明";
  }

  function firstRiskCondition(building, scope, scenarioFloods, scenarioId = state.scenarioId) {
    if(building.officialId && !Number.isFinite(building.groundElev))return '缺地面高程，起淹條件待評估；保留在Y，不當成零風險。';
    if (scenarioFloods.get(scenarioId)?.scenario && reportedNoOvertopping(scenarioFloods.get(scenarioId).scenario,scenarioFloods.get(scenarioId).scenario.effectiveLevel)) return '750 cms報告正常操作主流無溢堤；低地內水未逐棟評估，不可解讀為全區無淹水風險。本版固定流量750最終幀不加水位偏移；內水風險仍待評估。';
    const order = [scenarioId];
    for (const id of order) {
      const item = scenarioFloods.get(id);
      if (!item) continue;
      const floodState = buildingFloodState(
        building,
        item.flood.active,
        item.scenario.effectiveLevel,
        scope,
        item.flood.cellData
      );
      if (!floodState.connected || floodState.depth <= 0) continue;
      const flow = item.scenario.peakFlowCms == null ? "未列單一洪峰" : `${item.scenario.peakFlowCms.toLocaleString("zh-TW")} cms`;
      return `${item.scenario.analysisYear}年${item.scenario.name}、${item.scenario.constructionStateLabel}，洪峰${flow}、${item.scenario.section}，水位EL ${item.scenario.effectiveLevel.toFixed(2)}m時，足跡與河道連通水格相交且水位高於地面，列為本工況風險；不是發生年份或精確起淹門檻。${item.scenario.gateCondition}；洪峰品質：${levelQualityLabel(item.scenario.peakQuality)}；水位品質：${levelQualityLabel(item.scenario.levelQuality)}。`;
    }
    return '在本次所選Q10流量口徑、工程條件及基準水位下未達連通外溢風險；不代表其他工況或低地內水無淹水風險。';
  }

  function riskExportRow(building, lod, scenario, level, floodCells, scope, floodData, onsetCondition, populationCount) {
    const floodState = buildingFloodState(building, floodCells, level, scope, floodData);
    const connected = floodState.connected;
    const depth = floodState.depth;
    const regionalSource = REGIONAL.contextBuildingProvenance || {};
    const officialStoreys = building.officialStoreys == null ? "未取得／待官方資料核對" : building.officialStoreys;
    const detailSource = building.source || regionalSource.source || "NLSC BUILDX／PHOTO2";
    const detailCitation = building.citation || regionalSource.citation || "https://wmts.nlsc.gov.tw/wmts/BUILDX";
    const eventEstimate=buildingEventEstimate(building,scenario.constructionState||state.constructionState,scenario.peakFlowCms||1088);
    const wraLayer = state.wraLayerCatalog.find((item) => item.id === state.wraLayerId);
    const denominator = populationCount ?? buildingsForScope(scope).length;
    const rawScenario = rawScenarioById(scenario.id || scenario.scenarioId);
    const comparison = rawScenario ? comparisonForScenario(rawScenario, scope) : null;
    const currentFreeboard = 3.20 - level;
    const requiredRaise = Math.max(0, 0.50 - currentFreeboard);
    const waterDelta = Number((level - scenario.effectiveLevel).toFixed(2));
    const effectiveOnsetCondition = depth > 0 && Math.abs(waterDelta) > 0.001
      ? `${onsetCondition} 本次顯示另在${scenario.name}、${scenario.constructionStateLabel || "工程條件未註明"}之基準水位${waterDelta >= 0 ? "增加" : "降低"}${Math.abs(waterDelta).toFixed(2)}m至EL ${level.toFixed(2)}m；此偏移僅為敏感度試算，不是基本設計報告正式列值。`
      : onsetCondition;
    return {
      "建物識別碼": building.id,
      "建物名稱": building.name,
      "模型層級": lod,
      "建物統計口徑": fullCensusActive() ? "報告前後Q10範圍聯集內依BUILD_ID去重模型物件" : "本次可取得並固定之去重模型物件X/Y；不是報告全區X/Y",
      "本次計算範圍建物數Y": denominator,
      "本次計算範圍風險建物數X": censusRiskTotal(floodCells,level,scope,floodData),
      "本次固定清冊範圍說明": fullCensusActive() ? buildingCensus.fullManifest.scope.definition : JSON.stringify(currentCalculationScope(scope)),
      "風險建物（模型物件）數": floodState.unknown ? "地面高程待評估" : depth > 0 ? 1 : 0,
      "舊版樣本欄位說明": "本版改用本次計算範圍建物數Y，與報告全區Y分列",
      "報告影響範圍全部建物數Y": fullCensusActive() ? denominator : "待核算",
      "報告影響範圍風險建物數X": fullCensusActive() ? censusRiskTotal(floodCells,level,scope,floodData) : "待核算",
      "地面高程待評估物件數U": fullCensusActive() ? buildingCensus.fullManifest.missingGroundCount : currentCalculationScope(scope).missingGroundCount,
      "是否納入報告影響範圍": fullCensusActive() ? "是；建物完整水平投影與S有正面積相交" : "待原始淹水向量／網格空間相交",
      "報告影響範圍定義": fullCensusActive() ? buildingCensus.fullManifest.scope.definition : DATA.reportImpactScope.boundaryDefinition,
      "報告改建前後面積（公頃）": fullCensusActive() ? `${buildingCensus.fullManifest.scope.beforeAreaHa}／${buildingCensus.fullManifest.scope.afterAreaHa}；聯集${buildingCensus.fullManifest.scope.unionAreaHa}` : "1517.44／1141.60；聯集面積待核算",
      "報告範圍依據": DATA.reportImpactScope.report+"；"+DATA.reportImpactScope.sourcePages,
      "建物樣本版本": fullCensusActive() ? buildingCensus.fullManifest.version : state.buildingSource === 'official' ? buildingCensus.revision : '舊版衍生量體',
      "全區清冊完整性": fullCensusActive() ? "固定資料包完整索引／範圍已對帳；完整性依提供者涵蓋聲明，非現地戶數" : "未完成；不得解讀為全區風險建物普查",
      "風險結果性質": "使用者假設新閘門通洪門檻750 cms；流量驅動的靜態連通外溢篩檢，非正式水理成果",
      "建物來源模式": fullCensusActive() ? "NLSC固定版本建物資料＋離線統計清冊" : state.buildingSource === "official" ? "NLSC官方3D線上已載入樣本；不是全區總數" : "原BUILDX衍生模型",
      "官方圖磚網址": building.sourceUrl || "不適用",
      "官方模型資料日期": building.modelDate || building.sourceDate || "未提供",
      "官方模型底部高程（公尺）": building.officialModelMinHeightM ?? "未取得",
      "模型底部與DTM差（公尺）": building.verticalDifferenceM ?? "未取得",
      "官方模型原始屬性": building.officialAttributes ? JSON.stringify(building.officialAttributes) : "未取得",
      "建物母體範圍依據": fullCensusActive() ? `${buildingCensus.fullManifest.scope.source}；${buildingCensus.fullManifest.scope.definition}；聯集${buildingCensus.fullManifest.scope.unionAreaHa}公頃；${buildingCensus.fullManifest.scope.kind}` : (state.buildingSource === "official" ? "已載入並固定之BUILD_ID去重本次計算母體Y（非報告全區）；實際建物分布範圍見本次固定清冊範圍說明，歸屬報告影響範圍尚待核算。" : "") + "五結閘門中心(E334297.8226,N2731883.96675；EPSG:3826)向四側8公里之16×16公里／256平方公里互動初篩矩形；含海域、山地及集水區外土地，不等同冬山河110.52平方公里正式集水區或官方建物普查。",
      "幾何資料類型": building.geometryClass || (lod.startsWith("LOD1") ? "NLSC BUILDX展示圖層衍生參考量體" : "細部足跡衍生模型"),
      "是否為法定建物界線": building.legalBoundary === true ? "是" : "否",
      "檢討範圍": scope === "regional" ? "閘門置中16×16公里／256平方公里第一階段區域篩檢" : "0.4×0.4公里／0.16平方公里工程細部",
      "TWD97東向座標（公尺）": building.e,
      "TWD97北向座標（公尺）": building.n,
      "建物面積（平方公尺）": building.areaM2 ?? "未取得",
      "建物寬度（公尺）": building.width ?? "未取得",
      "建物深度（公尺）": building.depth ?? "未取得",
      "推估地面高程EL（公尺）": building.groundElev,
      "地面高程依據": building.groundElevBasis || "2025年版宜蘭20m DTM最近格點／區域粗估",
      "模型高度（公尺）": building.modelHeightM || building.height || "未取得",
      "官方樓層數": officialStoreys,
      "官方樓層核對狀態": building.officialStoreysStatus || "區域LOD1未逐棟匹配",
      "官方樓層依據": building.officialStoreysBasis || "待取得NLSC BUILD_NO、建照或使照逐棟匹配",
      "模型造型樓層": building.modelStoreys || "LOD量體",
      "模型樓層說明": building.heightBasis || "僅供3D量體造型，不是真實樓層或建管紀錄",
      "屋頂現況色": building.roofColor || "未分離建模",
      "立面現況色": building.facadeColor || "未取得",
      "材質來源類別": building.materialSourceClass || "NLSC_PHOTO2_FOOTPRINT_SAMPLE",
      "材質空間信心": building.materialSpatialConfidence || "REFERENCE_DERIVED",
      "材質依據": building.materialBasis || "NLSC PHOTO2建物足跡內影像取色；立面為衍生色",
      "建物足跡來源": building.footprintSource || "NLSC BUILDX公開展示圖層向量化參考",
      "建管資料匹配狀態": building.managementStatus || building.officialStoreysStatus || "未逐棟匹配建照／使照",
      "實價登錄匹配狀態": building.realEstateMatchStatus || "無可驗證地號、門牌或案件序號，未以鄰近交易冒充本棟",
      "地籍參考": building.parcelRef || "地籍正式向量尚未取得／待地政資料核對",
      "距五結閘門（公尺）": building.distanceToGateM ?? Number(Math.hypot(building.e - GATE_E, building.n - GATE_N).toFixed(1)),
      "評估年份": scenario.analysisYear,
      "情境識別碼": scenario.id,
      "情境名稱": scenario.name,
      "水位代表位置": scenario.section,
      "操作條件": scenario.gateCondition,
      "操作與比較限制": scenario.comparisonUnavailableReason || '相同工況前後比較；風險建物為靜態篩檢',
      "重現期": scenario.returnPeriod,
      "工程條件": scenario.constructionStateLabel || "未註明",
      "洪峰流量（cms）": scenario.peakFlowCms ?? "未列單一洪峰",
      "洪峰資料品質": levelQualityLabel(scenario.peakQuality),
      "洪峰推估公式": scenario.peakFormula || "未提供",
      "洪峰依據／流量口徑": `${scenario.peakBasis || "未提供"}；${scenario.flowDefinition || "未提供"}`,
      "情境水位EL（公尺）": Number(level.toFixed(2)),
      "水位資料品質": Math.abs(waterDelta)>.001 ? "假設流量歷程之展示換算；非報告列值" : levelQualityLabel(scenario.levelQuality),
      "基準代表水位EL（公尺）": scenario.effectiveLevel,
      "基準水位資料品質": levelQualityLabel(scenario.levelQuality),
      "本次展示流量（cms）": scenario.id===state.scenarioId ? state.displayFlowCms : scenario.peakFlowCms,
      "淹水情境性質": "使用者假設門檻＋分段H–Q展示換算（無手動水位偏移）",
      "是否為平均漲潮水位": "否；代表洪水位／操作峰加偏移，非平均潮位或全河段同步水位",
      "水位依據": scenario.levelBasis,
      "水位推估公式": scenario.levelFormula || "未提供",
      "同洪峰工程施作前水位EL（公尺）": comparison ? comparison.before.resolved.effectiveLevel.toFixed(2) : "未計算",
      "同洪峰工程施作後水位EL（公尺）": comparison ? comparison.after.resolved.effectiveLevel.toFixed(2) : (scenario.constructionState === 'after' ? scenario.effectiveLevel.toFixed(2) : '未計算'),
      "同洪峰工程前後水位差（公尺）": comparison ? comparison.waterLevelReductionM.toFixed(2) : "未計算",
      "同洪峰施作前風險建物（模型物件）數": comparison ? comparison.before.count : "未計算",
      "同洪峰施作後風險建物（模型物件）數": comparison ? comparison.after.count : "未計算",
      "同洪峰風險物件變化數": comparison ? comparison.reducedCount : "未計算",
      "河道輸洪／堤頂檢討": scenario.section18Comparable === false ? '內水操作歷程最高值非1K+600斷面水位，不計算該斷面出水高或加高需求。' : `1K+600現況堤頂EL3.20m，情境出水高${currentFreeboard.toFixed(2)}m；${currentFreeboard >= 0 ? "未達堤頂" : "高於堤頂"}；${currentFreeboard >= 0.50 ? "達0.50m標準" : `距0.50m尚差${requiredRaise.toFixed(2)}m`}`,
      "閘門排洪量檢討": scenario.gateDischargeBasis || "缺閘門Cd、有效開口及逐時水頭，未冒算容量",
      "河道連通判定": floodState.unknown ? '待評估（地面高程缺值）' : connected ? "是" : "否",
      "推估淹水深度（公尺）": floodState.unknown ? '待評估（地面高程缺值）' : Number(depth.toFixed(2)),
      "風險等級": floodState.unknown ? '待評估' : riskForDepth(depth),
      "風險分數": floodState.unknown ? '待評估' : depth > 0 ? Math.round(Math.min(100, depth * 70 + 10)) : 0,
      "開始風險條件（使用者假設）": eventEstimate.label,
      "起淹需求流量門檻估計（cms）": eventEstimate.flowCms ?? '本次情境未達／待估',
      "淹水到達時間估計（小時）": eventEstimate.hours ?? '本次情境未達／待估',
      "到達當時流量估計（cms）": eventEstimate.arrivalFlowCms ?? '本次情境未達／待估',
      "最終淹水深度估計（公尺）": eventEstimate.depth ?? '待估',
      "時間與流量假設依據": FLOW.explanation,
      "淹水推估方法": REGIONAL.hydrography?.method || "河道連通＋靜態水位減地面高程",
      "限制": "NLSC EMAP5河道圖面衍生＋20m來源DTM／40m分析格網最低鞍部外溢；256km²矩形含海域及集水區外範圍，非實測、非正式1D／2D水理結果",
      "建物資料來源": detailSource,
      "水文資料來源": scenario.source,
      "資料來源": `${detailSource}；河道：${REGIONAL.hydrography?.sourceTitle || "NLSC EMAP5_OPENDATA"}；水文情境：${scenario.source}`,
      "出處": `${detailCitation}；${REGIONAL.hydrography?.sourceUrl || "https://data.gov.tw/dataset/17214"}；${scenario.source}，${scenario.levelBasis}`,
    };
  }

  function riskHeaders(rows) {
    return Object.keys(rows[0] || riskExportRow(
      { id: "", name: "", e: "", n: "", groundElev: 0 },
      "", { analysisYear: "", returnPeriod: "", effectiveLevel: 0, levelQuality: "", levelBasis: "", source: "" },
      0, new Set(), "regional", new Map(), ""
    ));
  }

  function downloadRiskCsv(rows, filename) {
    const iterator = rows[Symbol.iterator]();
    const first = iterator.next();
    const headers = riskHeaders(first.done ? [] : [first.value]);
    const escape = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
    const encoder = new TextEncoder();
    const parts = [encoder.encode(`\ufeff${headers.map(escape).join(",")}\r\n`)];
    let chunk = [], item = first;
    while (!item.done) {
      chunk.push(headers.map(header => escape(item.value[header])).join(","));
      if (chunk.length >= 128) { parts.push(encoder.encode(chunk.join("\r\n")+"\r\n")); chunk=[]; }
      item = iterator.next();
    }
    if (chunk.length) parts.push(encoder.encode(chunk.join("\r\n")+"\r\n"));
    const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportFullRiskMatrix() {
    const scope = state.analysisScope;
    const population = buildingsForScope(scope);
    function* rows() {
      for (const constructionState of ["before", "after"]) {
        const scenarioFloods = scenarioFloodStates(scope, constructionState);
        for (const rawScenario of DATA.scenarios) {
          const scenario = resolveScenario(rawScenario, constructionState);
          if (!scenario) continue;
          const flood = scenarioFloods.get(rawScenario.id).flood;
          for (const {building,lod} of population) yield riskExportRow(building,lod,scenario,scenario.effectiveLevel,flood.active,scope,flood.cellData,firstRiskCondition(building,scope,scenarioFloods,rawScenario.id),population.length);
        }
      }
    }
    downloadRiskCsv(rows(), `${fullCensusActive()?"五結全區固定清冊":"五結暫存樣本_非報告全區"}_Q10風險矩陣_${scope}.csv`);
  }

  function stepWater(delta) {
    const slider = document.getElementById("water-slider");
    const next = THREE.MathUtils.clamp(Number(slider.value) + delta, -0.5, 0.5);
    setWaterOffset(next, true);
  }

  function setWaterOffset(value, stopAnimation = true) {
    return; // v16 replaces arbitrary water offsets with the explicit flow event.
    if (stopAnimation) stopFloodAnimation();
    const slider = document.getElementById("water-slider");
    const next = THREE.MathUtils.clamp(Number(value), Number(slider.min), Number(slider.max));
    slider.value = next.toFixed(2);
    state.waterOffset = next;
    updateScenarioPresentation();
  }

  function toggleFloodAnimation() {
    const animation=state.floodAnimation;
    if(animation.playing){animation.playing=false;animation.paused=true;updateQuickActions();updateEventStatus();return;}
    if(!animation.paused){
      state.scenarioId='TARGET2070_Q10';state.analysisYearId='TARGET_2070';
      document.getElementById('analysis-year').value=state.analysisYearId;
      renderScenarioButtons(state.analysisYearId);
      state.eventHours=0;state.displayFlowCms=FLOW.config.startFlowCms;state.eventActive=true;state.waterOffset=0;
    }
    animation.fromHours=state.eventHours;
    animation.start=performance.now();animation.lastFrame=0;
    animation.duration=FLOW.config.playbackSeconds*1000*(1-animation.fromHours/FLOW.endHours(HYDRO_MAX_ARRIVAL));
    animation.playing=true;animation.paused=false;
    updateScenarioPresentation();
  }

  function stopFloodAnimation(clearPause=true){
    state.floodAnimation.playing=false;
    if(clearPause)state.floodAnimation.paused=false;
  }

  function updateFloodAnimation(now){
    const animation=state.floodAnimation;
    if(!animation.playing||now-animation.lastFrame<180)return;
    animation.lastFrame=now;
    const p=Math.min(1,(now-animation.start)/animation.duration);
    state.eventHours=animation.fromHours+(FLOW.endHours(HYDRO_MAX_ARRIVAL)-animation.fromHours)*p;
    state.displayFlowCms=FLOW.flowAtHours(state.eventHours);
    updateScenarioPresentation();
    if(p>=1){animation.playing=false;animation.paused=false;state.eventActive=false;updateQuickActions();updateEventStatus();}
  }

  function updateEventStatus(){
    const box=document.getElementById('flow-event-status');
    const spilling=state.constructionState==='after'?state.displayFlowCms>750:activeFloodCells.size>0;
    const presentation=FLOW.presentation({hours:state.eventHours,playing:state.floodAnimation.playing,paused:state.floodAnimation.paused,eventActive:state.eventActive,spilling});
    document.getElementById('event-flow').textContent=state.displayFlowCms.toFixed(1)+' cms';
    document.getElementById('event-time').textContent=presentation.timeLabel;
    document.getElementById('event-spill').textContent=presentation.spillLabel;
    document.getElementById('event-spill').hidden=presentation.complete;
    document.getElementById('event-risk').textContent='受淹 '+state.currentRiskCount.toLocaleString('zh-TW')+'／'+buildingsForScope().length.toLocaleString('zh-TW');
    box.dataset.flow=String(state.displayFlowCms);box.dataset.hours=String(state.eventHours);
    box.dataset.assessment='USER_ASSUMED_SCREENING';
    box.dataset.phase=presentation.complete?'complete':state.floodAnimation.playing?'playing':state.floodAnimation.paused?'paused':'preview';
    document.getElementById('rain-effect').classList.toggle('raining',presentation.raining);
  }

  function rainSurfaceAt(x,z){
    const e=x+CENTER_E,n=CENTER_N-z,t=REGIONAL.terrain;
    const col=Math.floor((e-t.extent.xmin)/CELL),row=Math.floor((n-t.extent.ymin)/CELL);
    if(row<0||col<0||row>=t.rows-1||col>=t.cols-1)return null;
    const hydro=REGIONAL.hydrography;
    const wet=hydro?.mainRiverMaskSouthToNorth?.[row]?.[col]||hydro?.mappedWaterMaskSouthToNorth?.[row]?.[col];
    const flooded=activeFloodCells.has(row+':'+col);
    if(!wet&&!flooded)return null;
    return (flooded?currentWaterLevel():Math.max(sampleTerrain(e,n),currentWaterLevel()))-DATUM+.18;
  }

  function buildingEventEstimate(building,construction=state.constructionState,peak=rawScenarioById(state.scenarioId).peakFlowCms){
    if(!Number.isFinite(building.groundElev))return {label:'地面高程缺值；無法推估',flowCms:null,hours:null,depth:null};
    // Cache final grid by construction + selected peak, independent of animation/camera.
    const raw=DATA.scenarios.find(row=>row.peakFlowCms===peak)||rawScenarioById('TARGET2070_Q10');
    const summary=riskSummaryForScenario(raw,construction);
    const result=buildingFloodState(building,summary.flood.active,summary.resolved.effectiveLevel,state.analysisScope,summary.flood.cellData);
    if(result.depth<=0)return {label:'本次最終情境未達已知外溢風險（不代表安全）',flowCms:null,hours:null,depth:0};
    let earliest=null;
    const keys=building.floodCellKeys||Array.from(summary.flood.cellData.keys()).filter(key=>{
      const cell=summary.flood.cellData.get(key);return buildingContainsPoint(building,cell.e,cell.n);
    });
    for(const key of keys){
      const cell=summary.flood.cellData.get(key);if(!cell)continue;
      const item=FLOW.onset(Math.max(cell.spillElevation,building.groundElev+0.005001,summary.resolved.effectiveLevel-cell.depth+0.005001),cell.arrivalDistance,construction);
      if(item.hours!=null&&item.flowCms<=peak&&(!earliest||item.hours<earliest.hours))earliest=item;
    }
    if(!earliest)return {label:'連通投影資料不足，起淹時間待估',flowCms:null,hours:null,depth:result.depth};
    const arrivalQ=Math.min(peak,earliest.arrivalFlowCms);
    return {...earliest,arrivalFlowCms:arrivalQ,depth:result.depth,label:'需求門檻約 '+earliest.flowCms.toFixed(1)+' cms；估計起淹於情境開始後 '+earliest.hours.toFixed(2)+' 小時（當時約 '+arrivalQ.toFixed(1)+' cms）；最終水深 '+result.depth.toFixed(2)+' m。僅為假設歷程與0.5m/s格網傳播估計。'};
  }

  function onPointerUp(event) {
    const start = pointerDown;
    pointerDown = null;
    if (event.button !== 0 || !start || event.pointerId !== start.pointerId
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const visibleClickables = currentClickables();
    if (state.freeExplore) {
      const navigationHits = raycaster.intersectObjects([terrainMesh, ...visibleClickables], false);
      if (navigationHits.length) recenterFreeExplore(navigationHits[0].point);
      return;
    }
    const hits = raycaster.intersectObjects(visibleClickables, false);
    if (hits.length) {
      const resolved = resolveHit(hits[0]);
      if (resolved) {
        showSelection(resolved.kind, resolved.data, resolved.instanceId);
        openObjectModal();
      }
    }
  }

  function resolveHit(hit) {
    if (!isHierarchyVisible(hit?.object)) return null;
    const userData = hit?.object?.userData;
    if (!userData?.kind) return null;
    if (userData.kind === "official-building-batch") return officialBuildings?.resolveHit(hit) || null;
    if (userData.kind === "official-building") return {kind: userData.kind, data: userData.building, instanceId: null};
    if (userData.kind !== "regional-building") {
      return userData.data ? { kind: userData.kind, data: userData.data, instanceId: null } : null;
    }
    const instanceId = hit.instanceId;
    if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= userData.data.length) return null;
    return { kind: userData.kind, data: userData.data[instanceId], instanceId };
  }

  function isHierarchyVisible(object) {
    let current = object;
    while (current) {
      if (current.visible === false) return false;
      current = current.parent;
    }
    return true;
  }

  function onPointerMove(event) {
    if (state.freeExplore) {
      renderer.domElement.style.cursor = "crosshair";
      return;
    }
    pendingHoverPoint = { clientX: event.clientX, clientY: event.clientY };
    if (hoverRaycastFrame !== null) return;
    hoverRaycastFrame = window.requestAnimationFrame(() => {
      hoverRaycastFrame = null;
      if (!pendingHoverPoint || state.freeExplore) return;
      setPointer(pendingHoverPoint);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(currentClickables(), false);
      renderer.domElement.style.cursor = hits.length ? "pointer" : "grab";
    });
  }

  function setPointer(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function setFreeExplore(enabled, announce = true, exitMethod = null) {
    state.freeExplore = Boolean(enabled);
    state.cameraTransition = null;
    controls.enablePan = true;
    controls.screenSpacePanning = state.freeExplore;
    controls.mouseButtons.RIGHT = state.freeExplore ? null : defaultRightMouseAction;
    if (state.freeExplore) {
      state.cameraView = "free";
    } else {
      state.cameraView = state.fixedCameraView || "regional";
    }
    canvas.classList.toggle("free-explore", state.freeExplore);
    const button = document.getElementById("toggle-free-explore");
    const quick = document.getElementById("quick-free-explore");
    const note = document.getElementById("free-explore-note");
    if (button) {
      button.classList.toggle("active", state.freeExplore);
      button.setAttribute("aria-pressed", String(state.freeExplore));
      button.textContent = state.freeExplore ? "退出自由瀏覽" : "啟用自由瀏覽";
    }
    if (quick) {
      quick.classList.toggle("active", state.freeExplore);
      quick.setAttribute("aria-pressed", String(state.freeExplore));
    }
    if (note && announce) note.textContent = state.freeExplore
      ? "自由瀏覽已啟用：左鍵點模型任一位置可立即設為旋轉中心；拖曳旋轉、滾輪縮放；按滑鼠右鍵可直接退出並恢復所有建物／工程點擊資訊。"
      : exitMethod === "right-click"
        ? "已用滑鼠右鍵退出自由瀏覽；現在可直接點擊任一區域建物、細部建物或工程設施查看資訊。"
        : "固定視角仍可旋轉與縮放；啟用後可用左鍵重設視角中心，按滑鼠右鍵直接退出，再點擊所有建物／工程查看資訊。";
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      freeExplore: state.freeExplore,
      freeExploreExitMethod: exitMethod,
    });
    updateQuickActions();
  }

  function recenterFreeExplore(point) {
    const previous = controls.target.clone();
    const delta = point.clone().sub(previous);
    controls.target.copy(point);
    camera.position.add(delta.multiplyScalar(0.35));
    controls.update();
    const note = document.getElementById("free-explore-note");
    if (note) note.textContent = `自由中心已移至場景座標 X ${point.x.toFixed(0)}、Z ${point.z.toFixed(0)}；可繼續點選其他位置、旋轉、縮放或平移。`;
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      freeExplore: true,
      freeExploreTarget: { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)), z: Number(point.z.toFixed(2)) },
    });
  }

  function showSelection(kind, data, instanceId = null) {
    state.selected = { kind, data, instanceId };
    document.getElementById("info-detail").hidden = false;
    document.getElementById("open-object-info").disabled = false;
    const badge = document.getElementById("info-badge");
    badge.className = "risk-badge neutral";
    setDetailSourceLinks([]);
    document.getElementById("detail-id").textContent = data.id || "—";
    document.getElementById("detail-parcel").textContent = "—";
    document.getElementById("detail-management").textContent = "—";
    document.getElementById("detail-material").textContent = "—";
    document.getElementById("detail-real-estate").textContent = "不適用";
    document.getElementById("detail-real-estate-status").textContent = "非建物物件";
    document.getElementById("detail-condition").textContent = "不適用";
    document.getElementById("detail-event").textContent = kind.includes("building") ? buildingEventEstimate(data).label : "不適用";
    document.getElementById("detail-footprint-note").textContent = "建物足跡是建物垂直投影至地面的平面輪廓與占地範圍；工程或場景定位物件不適用。";

    if (kind === "official-building") {
      const flood = buildingFloodState(data), risk = riskForDepth(flood.depth), a = data.officialAttributes;
      document.getElementById("info-title").textContent = data.name;
      const noOverflow = reportedNoOvertopping(currentScenario(),currentWaterLevel());
      badge.textContent = flood.unknown ? '地面高程缺值／風險待評估' : noOverflow ? '主流無溢堤／內水待算' : risk + "概估風險"; badge.className = flood.unknown ? 'risk-badge neutral' : "risk-badge " + riskClass(risk);
      document.getElementById("detail-type").textContent = officialBuildings?.isOffline ? "NLSC固定版本分棟官方3D（離線模型）" : "NLSC宜蘭縣分棟版官方3D（線上圖磚）";
      document.getElementById("detail-ground").textContent = Number.isFinite(data.groundElev) ? "DTM EL " + data.groundElev.toFixed(2) + "m；官方模型底部 " + data.officialModelMinHeightM.toFixed(2) + "m；差 " + data.verticalDifferenceM.toFixed(2) + "m（垂直基準待複核）" : "DTM缺值：保留在全部建物Y；風險待評估。官方模型底部EL "+data.officialModelMinHeightM.toFixed(2)+"m（垂直基準待複核）";
      document.getElementById("detail-coordinates").textContent = "TWD97 E "+data.e+"；N "+data.n;
      document.getElementById("detail-dimensions").textContent = "官方模型高 "+data.modelHeightM.toFixed(2)+"m／BUILD_NO "+(data.officialStoreys??"未填")+"；樓層來源 "+(a.NO_SOURCE||"未填");
      document.getElementById("detail-footprint-note").textContent = "足跡＝官方3D網格的垂直投影。逐三角形與淹水格相交，不是地籍或室內面積；不以矩形方塊替代本棟幾何。";
      document.getElementById("detail-depth").textContent = flood.unknown ? '待取得地面高程；不可填0m' : flood.depth.toFixed(2)+"m（20m DTM靜態篩檢）";
      document.getElementById("detail-score").textContent = flood.unknown ? '未知；已納入Y，未列為已知風險X，亦不認定安全' : noOverflow ? '低地內水風險尚未評估；不能認定本棟安全' : risk+"；不作正式災損認定";
      document.getElementById("detail-distance").textContent = Math.hypot(data.e-GATE_E,data.n-GATE_N).toFixed(1)+"m";
      document.getElementById("detail-management").textContent = "NLSC BUILD_NO "+(a.BUILD_NO||"未填")+"／NO_SOURCE "+(a.NO_SOURCE||"未填")+"；尚未另匹配建照、使照";
      document.getElementById("detail-material").textContent = "白模；隨連通水深由淡紅至深紅，退水恢復白色";
      document.getElementById("detail-real-estate").textContent = "新官方ID尚未綁定實價登錄個案；不沿用舊物件匹配";
      document.getElementById("detail-real-estate-status").textContent = "待可靠識別碼匹配";
      document.getElementById("detail-condition").textContent = flood.unknown ? '缺地面高程，無法判斷起淹條件。' : firstRiskCondition(data,state.analysisScope,scenarioFloodStates(state.analysisScope));
      document.getElementById("detail-description").textContent = "LOD "+(a.MODEL_LOD||"未填")+"；建物資料日 "+(a.MDATE||"未填")+"；模型資料日 "+(a.M_MDATE||"未填")+"；建物框來源 "+(a.SOURCE_DES||a.SOURCE||"未填")+"；高度來源 "+(a.H_SOURCE||"未填")+"。模型高程與2025版DTM存在時相及基準差異，需測量複核。";
      document.getElementById("detail-source").textContent = data.source+"；官方ID "+data.officialId+"；情境出處："+currentScenario().source;
      if(officialBuildings?.isOffline){
        document.getElementById("detail-source").textContent += '；固定資料包原始檔：'+data.citation+'；清冊版本：'+buildingCensus.fullManifest.version;
        setDetailSourceLinks(data.sourceUrl ? [{label:'資料包原始供應來源（非本棟個案頁）',url:data.sourceUrl}] : []);
      } else setDetailSourceLinks([{label:"本棟所在官方GLB圖磚（含原始屬性）",url:data.sourceUrl},{label:"官方3D服務清單",url:"https://3dtiles.nlsc.gov.tw/tiles3d/Service"}]);
      document.getElementById("info-summary").textContent = (flood.unknown ? '高程缺值／風險待評估' : noOverflow ? '主流無溢堤／內水待算' : risk+'概估風險')+'｜'+(buildingCensus.records.has(data.id)?(fullCensusActive()?'已納入全區固定母體Y':'已納入本次計算母體Y'):'未納入本次計算；請先擴充清冊');
      window.WUJIE_RUNTIME_QA.selectedOfficialBuildingId=data.id;
    } else if (kind === "regional-building") {
      const regionalSource = REGIONAL.contextBuildingProvenance || {};
      const distance = Math.hypot(data.e - 334297.8226, data.n - 2731883.96675);
      const floodState = state.analysisScope === "regional"
        ? buildingFloodState(data)
        : { connected: false, depth: 0 };
      const depth = floodState.depth;
      const risk = riskForDepth(depth);
      document.getElementById("info-title").textContent = `${data.name} ${data.id}`;
      badge.textContent = `${risk}風險`;
      badge.className = `risk-badge ${riskClass(risk)}`;
      document.getElementById("detail-type").textContent = "NLSC BUILDX區域參考量體";
      document.getElementById("detail-ground").textContent = `EL ${data.groundElev.toFixed(2)} m（20m DTM）`;
      document.getElementById("detail-coordinates").textContent = `E ${data.e}；N ${data.n}`;
      document.getElementById("detail-dimensions").textContent = `約 ${data.width.toFixed(1)}×${data.depth.toFixed(1)} m／LOD模型高 ${data.height.toFixed(1)} m`;
      document.getElementById("detail-footprint-note").textContent = "本區足跡係NLSC BUILDX公開展示圖層中的建物框向量化後之地面投影範圍；區域LOD1以寬×深近似建模。它不是地籍、產權界線、室內面積或現地測量成果。";
      document.getElementById("detail-depth").textContent = `${depth.toFixed(2)} m（區域篩檢）`;
      document.getElementById("detail-score").textContent = depth > 0 ? `${Math.round(Math.min(100, depth * 70 + 10))} / 100（篩檢）` : "目前水位未連通危及";
      document.getElementById("detail-distance").textContent = `${distance.toFixed(1)} m`;
      document.getElementById("detail-parcel").textContent = "地籍參考尚待正式服務取得";
      document.getElementById("detail-management").textContent = "正式樓層未匹配；不得由LOD模型高度推定";
      document.getElementById("detail-material").textContent = `NLSC PHOTO2足跡取色／${data.roofColor}`;
      document.getElementById("detail-real-estate").textContent = "尚無可可靠綁定至本棟的內政部實價登錄公開紀錄識別碼。";
      document.getElementById("detail-real-estate-status").textContent = "區域LOD1僅完成BUILDX位置衍生；需取得可驗證地號、門牌、建物標示或官方BUILD_NO後才能逐棟匹配。";
      document.getElementById("detail-condition").textContent = firstRiskCondition(data, state.analysisScope, scenarioFloodStates(state.analysisScope));
      document.getElementById("detail-description").textContent = `${currentScenario().name}、${currentScenario().constructionStateLabel}下，以NLSC EMAP5冬山河圖面水面、20m來源DTM最低鞍部及40m分析格網進行第一階段外溢篩檢。${data.limitations || regionalSource.limitations || ""}`;
      document.getElementById("detail-source").textContent = `${data.source || regionalSource.source || "NLSC BUILDX／PHOTO2"}；水文情境：${currentScenario().source}。結果非官方淹水圖、非正式2D水理成果。`;
      setDetailSourceLinks([
        { label: "NLSC BUILDX圖層說明", url: "https://maps.nlsc.gov.tw/pro/get_map_message.jsp" },
        { label: "NLSC PHOTO2圖層清冊", url: "https://maps.nlsc.gov.tw/pro/003_layer.html" },
        { label: "NLSC臺灣通用電子地圖開放資料", url: "https://data.gov.tw/dataset/17214" },
        { label: "內政部實價登錄公開資料集", url: "https://data.gov.tw/dataset/25119" },
      ]);
      document.getElementById("info-summary").textContent = `${risk}風險｜區域概估水深 ${depth.toFixed(2)}m｜距閘門約 ${distance.toFixed(0)}m`;
      window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
        selectedRegionalBuildingId: data.id,
        selectedRegionalBuildingInstanceId: instanceId,
      });
    } else if (kind === "building") {
      const floodState = buildingFloodState(data);
      const depth = floodState.depth;
      const affected = depth > 0;
      const risk = riskForDepth(depth);
      document.getElementById("info-title").textContent = data.name;
      badge.textContent = `${risk}風險`;
      badge.className = `risk-badge ${riskClass(risk)}`;
      document.getElementById("detail-type").textContent = "NLSC建物框衍生3D／正式樓層待核";
      document.getElementById("detail-ground").textContent = `EL ${data.groundElev.toFixed(2)} m`;
      document.getElementById("detail-coordinates").textContent = `E ${data.e}；N ${data.n}`;
      document.getElementById("detail-dimensions").textContent = `足跡約 ${data.areaM2.toFixed(1)} m²／模型分層 ${data.modelStoreys || "—"}（僅造型）`;
      document.getElementById("detail-footprint-note").textContent = `本棟足跡係NLSC建物框衍生的封閉地面平面輪廓，約${data.areaM2.toFixed(1)}m²，用於定位、建立3D量體及與40m淹水格網相交判定；不是產權界線、室內面積或實測建坪。`;
      document.getElementById("detail-depth").textContent = `${depth.toFixed(2)} m`;
      document.getElementById("detail-score").textContent = affected ? `${data.riskScore} / 100` : "目前水位未連通危及";
      document.getElementById("detail-distance").textContent = `${data.distanceToGateM.toFixed(1)} m`;
      document.getElementById("detail-parcel").textContent = data.parcelRef || "地籍參考尚待取得";
      document.getElementById("detail-management").textContent = data.officialStoreys == null
        ? "待NLSC BUILD_NO／NO_SOURCE或建照、使照逐棟核對"
        : `${data.officialStoreys}層（官方資料已核對）`;
      document.getElementById("detail-material").textContent = `NLSC底圖逐棟取色／屋頂 ${data.roofColor}、立面衍生 ${data.facadeColor}`;
      const publicInfo = buildingPublicInfo(data);
      document.getElementById("detail-real-estate").textContent = publicInfo && publicInfo.values
        ? publicInfo.values
        : "查無可可靠綁定至本棟的內政部實價登錄案件；不顯示鄰近交易價格。";
      document.getElementById("detail-real-estate-status").textContent = publicInfo
        ? `查核日${publicInfo.checkedDate}｜${publicInfo.matchStatus}｜${publicInfo.reason}`
        : "本棟不在逐棟公開資訊查核清冊。";
      document.getElementById("detail-condition").textContent = firstRiskCondition(data, state.analysisScope, scenarioFloodStates(state.analysisScope));
      const quality = currentScenario().levelQuality === "OFFICIAL_REPORTED" ? "報告列值" : "篩檢外推";
      document.getElementById("detail-description").textContent = `${currentScenario().name}、${currentScenario().constructionStateLabel}（${currentScenario().peakFlowCms.toLocaleString("zh-TW")} cms；水位品質：${quality}）下，以NLSC EMAP5冬山河圖面水面為源，依20m來源DTM最低鞍部控制40m格網外溢，再以情境有效水位減去粗估地面高程。${data.heightBasis}；${data.materialBasis}。`;
      document.getElementById("detail-source").textContent = `${data.source}；${currentScenario().source}。足跡為公開展示圖層衍生參考，模型分層不代表真實樓層，亦不作法定建物或界址認定。內政部實價登錄因尚無本棟可驗證紀錄識別碼，不提供通用入口冒充逐筆連結。`;
      setDetailSourceLinks([
        { label: "本期實價登錄原始資料集", url: "https://data.gov.tw/dataset/25119" },
        { label: "NLSC三維建物屬性表", url: "https://3dmaps.nlsc.gov.tw/NLSC/uploadData/%E4%B8%89%E7%B6%AD%E5%BB%BA%E7%89%A9%E6%A8%A1%E5%9E%8B%E5%B1%AC%E6%80%A7%E8%A1%A8.pdf" },
        { label: "NLSC BUILDX圖層說明", url: "https://maps.nlsc.gov.tw/pro/get_map_message.jsp" },
        { label: "NLSC臺灣通用電子地圖開放資料", url: "https://data.gov.tw/dataset/17214" },
      ]);
      document.getElementById("info-summary").textContent = `${risk}風險｜概估水深 ${depth.toFixed(2)}m｜距閘門 ${data.distanceToGateM.toFixed(0)}m`;
    } else if (kind === "parcel") {
      const center = data.center || data.queryPoint || { e: 0, n: 0 };
      const distance = Math.hypot(center.e - 334285, center.n - 2731940);
      document.getElementById("info-title").textContent = data.displayName || `${data.sectionName} ${data.landNo} 地號`;
      badge.textContent = "地籍參考";
      badge.className = "risk-badge medium";
      document.getElementById("detail-type").textContent = "土地宗地／公開便民查詢";
      document.getElementById("detail-ground").textContent = `${data.zoning || "未取得"}／${data.landUse || "未取得"}`;
      document.getElementById("detail-coordinates").textContent = `E ${center.e}；N ${center.n}`;
      document.getElementById("detail-dimensions").textContent = data.registeredAreaM2 ? `${data.registeredAreaM2.toLocaleString("zh-TW")} m²` : "未取得";
      document.getElementById("detail-depth").textContent = "不適用";
      document.getElementById("detail-score").textContent = "非即時／僅供參考";
      document.getElementById("detail-distance").textContent = `${distance.toFixed(1)} m`;
      document.getElementById("detail-parcel").textContent = `${data.sectionName || "—"} ${data.landNo || "—"}`;
      document.getElementById("detail-management").textContent = "可用地號至官方系統續查";
      document.getElementById("detail-material").textContent = "地籍參考不適用";
      document.getElementById("detail-condition").textContent = "地籍圖層不直接判定建物淹水";
      const currentValue = data.announcedLandValueNtdM2 ? `公告土地現值 ${data.announcedLandValueNtdM2.toLocaleString("zh-TW")} 元/m²` : "公告土地現值未取得";
      const announcedPrice = data.announcedLandPriceNtdM2 ? `公告地價 ${data.announcedLandPriceNtdM2.toLocaleString("zh-TW")} 元/m²` : "公告地價未取得";
      document.getElementById("detail-description").textContent = `${data.areaName || "宜蘭縣五結鄉"}，地段代碼 ${data.sectionNo}，${currentValue}，${announcedPrice}（${data.referenceYear || "資料年度依來源"}）。不含所有權人資料。`;
      document.getElementById("detail-source").textContent = `${data.source || "內政部地籍圖資網路便民服務系統"}。${data.disclaimer || "實際界址以地政機關認定為準。"}`;
      setDetailSourceLinks(data.sourceUrl ? [{ label: "開啟本宗地官方資料", url: data.sourceUrl }] : []);
      document.getElementById("info-summary").textContent = "地籍公開參考；不得作界址認定";
    } else if (kind === "gate") {
      document.getElementById("info-title").textContent = data.name;
      badge.textContent = data.status;
      document.getElementById("detail-type").textContent = "水工構造物／防潮閘門";
      document.getElementById("detail-ground").textContent = `閘頂 EL ${data.topElev.toFixed(2)} m`;
      document.getElementById("detail-coordinates").textContent = `E ${data.e}；N ${data.n}`;
      document.getElementById("detail-dimensions").textContent = `總寬約 ${data.length} m`;
      document.getElementById("detail-depth").textContent = currentWaterLevel() > data.topElev ? `高出 ${(currentWaterLevel() - data.topElev).toFixed(2)} m` : `餘裕 ${(data.topElev - currentWaterLevel()).toFixed(2)} m`;
      document.getElementById("detail-score").textContent = data.id === "G-DESIGN" ? "P1/P2座標控制／位置已複核" : "PHOTO2 2023／位置已複核";
      document.getElementById("detail-distance").textContent = "工區核心";
      document.getElementById("detail-parcel").textContent = "工程設施／不適用";
      document.getElementById("detail-management").textContent = "依工程圖說，不屬建照推定";
      document.getElementById("detail-material").textContent = data.renderMode === "WHITE_MODEL" ? "新建／設計工程白模" : "既有設施NLSC底圖範圍取色";
      document.getElementById("detail-condition").textContent = currentWaterLevel() > data.topElev ? "目前情境水位高於閘頂" : "目前情境水位低於閘頂";
      document.getElementById("detail-description").textContent = data.id === "G-DESIGN" ? "本工程包含排洪閘門4扇、生態操作閘門2扇及船閘1座，閘址調整至原址上游約40m。改善後採6道30.5m閘門加9m船閘；軸線以圖說P1/P2座標控制。通洪能力需連同開度、內外水頭與操作歷程檢討；750 cms為報告高地洪峰操作情境，不等同固定最大容量。新建工程固定白模。" : "既有構造軸線依NLSC PHOTO2 2023官方正射影像判釋；材質逐設施取目前顯示之同一NLSC底圖範圍色碼。";
      document.getElementById("detail-source").textContent = `${data.source || "核心分析報告與DHDK-001工程圖說。"}；${data.materialBasis || "材質待核"}；${data.citation || ""}`;
      setDetailSourceLinks([
        { label: "宜蘭縣政府本工程說明", url: "https://wres.e-land.gov.tw/cp.aspx?n=11429" },
        ...(data.id === "G-EXISTING" ? [{ label: "NLSC PHOTO2圖層清冊", url: "https://maps.nlsc.gov.tw/pro/003_layer.html" }] : []),
      ]);
      document.getElementById("info-summary").textContent = `${data.status}｜閘頂 EL ${data.topElev.toFixed(2)}m｜點擊查看完整來源`;
    } else if (kind === "dike") {
      document.getElementById("info-title").textContent = data.name;
      const freeboard = data.topElev - currentWaterLevel();
      badge.textContent = freeboard < 0.5 ? "出水高注意" : "一般";
      badge.className = `risk-badge ${freeboard < 0.3 ? "high" : freeboard < 0.5 ? "medium" : "neutral"}`;
      document.getElementById("detail-type").textContent = "線型工程／海堤堤防";
      document.getElementById("detail-ground").textContent = `堤頂 EL ${data.topElev.toFixed(2)} m`;
      document.getElementById("detail-coordinates").textContent = `${data.points.length} 個概化控制點`;
      document.getElementById("detail-dimensions").textContent = "堤頂寬約 1.60 m（圖說）";
      document.getElementById("detail-depth").textContent = `出水高 ${freeboard.toFixed(2)} m`;
      document.getElementById("detail-score").textContent = freeboard < 0.5 ? "未達0.5m" : "達0.5m";
      document.getElementById("detail-distance").textContent = "—";
      document.getElementById("detail-parcel").textContent = "工程線位／不適用";
      document.getElementById("detail-management").textContent = "不適用";
      document.getElementById("detail-material").textContent = "工程線型中性材質";
      document.getElementById("detail-condition").textContent = freeboard < 0.5 ? "目前情境出水高未達0.5m" : "目前情境出水高達0.5m";
      document.getElementById("detail-description").textContent = "出水高以堤頂高程減情境水位概估；局部高程仍應以竣工測量與實測斷面為準。";
      document.getElementById("detail-source").textContent = "核心分析報告第十節；既有海堤改善標準剖面圖DHDK-004。";
      setDetailSourceLinks([{ label: "宜蘭縣政府本工程說明", url: "https://wres.e-land.gov.tw/cp.aspx?n=11429" }]);
      document.getElementById("info-summary").textContent = `${badge.textContent}｜堤頂 EL ${data.topElev.toFixed(2)}m｜出水高 ${freeboard.toFixed(2)}m`;
    } else {
      document.getElementById("info-title").textContent = data.name;
      badge.textContent = "圖資參考";
      document.getElementById("detail-type").textContent = data.type === "road" ? "道路／方位標記" : "橋梁方向標記";
      document.getElementById("detail-ground").textContent = `約 EL ${sampleTerrain(data.e, data.n).toFixed(2)} m`;
      document.getElementById("detail-coordinates").textContent = `E ${data.e}；N ${data.n}`;
      document.getElementById("detail-dimensions").textContent = "場景定位標記";
      document.getElementById("detail-depth").textContent = "—";
      document.getElementById("detail-score").textContent = "—";
      document.getElementById("detail-distance").textContent = `${Math.hypot(data.e - 334285, data.n - 2731940).toFixed(1)} m`;
      document.getElementById("detail-parcel").textContent = "方位標記／未關聯";
      document.getElementById("detail-management").textContent = "不適用";
      document.getElementById("detail-material").textContent = "場景定位標記色";
      document.getElementById("detail-condition").textContent = "場景定位物件，不直接進行風險判定";
      document.getElementById("detail-description").textContent = "用於協助判讀工區周邊道路、橋梁方向與場景方位；不是結構尺寸模型。";
      document.getElementById("detail-source").textContent = "使用者提供 Google 影像參考、NLSC 政府公開圖資與 DHDK-001 工程配置圖交叉校正。";
      setDetailSourceLinks([{ label: "NLSC圖層清冊", url: "https://maps.nlsc.gov.tw/pro/003_layer.html" }]);
      document.getElementById("info-summary").textContent = "場景定位參考；點擊查看完整資料來源與限制";
    }
    updateSelectionHelper(kind, data);
  }

  function updateSelectionHelper(kind, data) {
    if (selectionHelper) {
      selectionHelper.parent?.remove(selectionHelper);
      selectionHelper.geometry.dispose();
      selectionHelper.material.dispose();
      selectionHelper = null;
    }
    if (kind === "regional-building") {
      const geometry = new THREE.BoxGeometry(data.width * 1.18, data.height + 1.4, data.depth * 1.18);
      const material = new THREE.MeshBasicMaterial({
        color: "#ffd166", wireframe: true, transparent: true, opacity: 1,
        depthTest: false, depthWrite: false, toneMapped: false,
      });
      selectionHelper = new THREE.Mesh(geometry, material);
      selectionHelper.position.copy(localPosition(data.e, data.n, data.groundElev + data.height / 2 + 0.5));
      selectionHelper.rotation.y = THREE.MathUtils.degToRad(-data.angleDeg);
      selectionHelper.renderOrder = 100;
      worldRoot.add(selectionHelper);
      return;
    }
    const record = kind === "building" ? buildingObjects.get(data.id) : null;
    const target = record ? record.group : kind === "parcel" ? parcelObjects.get(data.id) : engineeringObjects.get(data.id);
    if (!target) return;
    target.updateWorldMatrix(true, true);
    selectionHelper = new THREE.BoxHelper(target, "#ffbd55");
    selectionHelper.material.transparent = true;
    selectionHelper.material.opacity = 0.9;
    selectionHelper.material.depthTest = false;
    selectionHelper.renderOrder = 20;
    scene.add(selectionHelper);
  }

  function riskClass(risk) {
    return ({ "無": "neutral", "低": "low", "中": "medium", "高": "high", "極高": "extreme" })[risk];
  }

  function labelFilterCategory(category) {
    if (category === "road") return "road";
    if (category === "river") return "river";
    if (category === "attraction" || category === "place") return "place";
    if (category === "building") return "building";
    return "engineering";
  }

  function addLabel(text, localOffset, parent, options = {}) {
    const anchor = new THREE.Object3D();
    anchor.position.copy(localOffset);
    parent.add(anchor);
    const element = document.createElement("div");
    element.className = "scene-label";
    if (options.category) element.classList.add(`label-${options.category}`);
    element.textContent = text;
    app.appendChild(element);
    labelAnchors.push({
      anchor,
      element,
      filterCategory: options.filterCategory || labelFilterCategory(options.category),
      priority: options.priority || 90,
      maxDistance: options.maxDistance || 2800,
    });
  }

  function updateLabels() {
    if (!state.labels) {
      labelAnchors.forEach(({ element }) => { element.hidden = true; });
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const world = new THREE.Vector3();
    const candidates = [];
    labelAnchors.forEach(({ anchor, element, filterCategory, priority, maxDistance }) => {
      anchor.getWorldPosition(world);
      const distance = camera.position.distanceTo(world);
      const projected = world.clone().project(camera);
      const categoryVisible = state.labelCategories[filterCategory] !== false && !(state.buildingSource === "official" && /BUILDX建物框參考|NLSC建物框衍生3D/.test(element.textContent));
      const visible = categoryVisible && isHierarchyVisible(anchor) && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08 && distance < maxDistance;
      element.hidden = !visible;
      if (visible) {
        candidates.push({
          element,
          priority,
          distance,
          x: (projected.x * 0.5 + 0.5) * width,
          y: (-projected.y * 0.5 + 0.5) * height,
        });
      }
    });
    const accepted = [];
    candidates.sort((a, b) => b.priority - a.priority || a.distance - b.distance).forEach((candidate) => {
      const halfWidth = Math.max(42, candidate.element.textContent.length * 7.2);
      const collides = accepted.some((placed) =>
        Math.abs(placed.x - candidate.x) < placed.halfWidth + halfWidth + 10
        && Math.abs(placed.y - candidate.y) < 28
      );
      candidate.element.hidden = collides;
      if (collides) return;
      candidate.element.style.left = `${candidate.x}px`;
      candidate.element.style.top = `${candidate.y}px`;
      candidate.element.style.opacity = String(THREE.MathUtils.clamp(1.15 - candidate.distance / 30000, 0.56, 1));
      accepted.push({ x: candidate.x, y: candidate.y, halfWidth });
    });
  }

  function setCameraView(view, animateView) {
    const views = {
      regional: { position: new THREE.Vector3(GATE_X + 2200, 14000, GATE_Z + 15000), target: new THREE.Vector3(GATE_X, 3, GATE_Z) },
      overview: { position: new THREE.Vector3(450, 520, 470), target: new THREE.Vector3(0, 3, 5) },
      top: { position: new THREE.Vector3(GATE_X, 19000, GATE_Z + 1), target: new THREE.Vector3(GATE_X, 0, GATE_Z) },
      gate: { position: new THREE.Vector3(180, 105, 175), target: new THREE.Vector3(0, 3, 20) },
      village: { position: new THREE.Vector3(20, 105, 130), target: new THREE.Vector3(-105, 4, -125) },
    };
    const resolvedView = views[view] ? view : "regional";
    const next = views[resolvedView];
    if (state.freeExplore) setFreeExplore(false, false);
    state.cameraView = resolvedView;
    state.fixedCameraView = resolvedView;
    updateQuickActions();
    if (!animateView) {
      camera.position.copy(next.position);
      controls.target.copy(next.target);
      controls.update();
      return;
    }
    state.cameraTransition = {
      start: performance.now(),
      duration: 720,
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPosition: next.position,
      toTarget: next.target,
    };
  }

  function updateCameraTransition(now) {
    const transition = state.cameraTransition;
    if (!transition) return;
    const raw = Math.min(1, (now - transition.start) / transition.duration);
    const eased = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    camera.position.lerpVectors(transition.fromPosition, transition.toPosition, eased);
    controls.target.lerpVectors(transition.fromTarget, transition.toTarget, eased);
    if (raw >= 1) state.cameraTransition = null;
  }

  function disposeGroup(group) {
    group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
  }

  function animate(now) {
    const delta = Math.min(clock.getDelta(), 0.05);
    updateFloodAnimation(now);
    updateCameraTransition(now);
    controls.update(delta);
    rainRipples?.update(delta,state.floodAnimation.playing,controls.target,camera.position.distanceTo(controls.target));
    officialBuildings?.update(now, camera, controls.target);
    if (riverMesh) riverMesh.material.opacity = 0.28;
    if (selectionHelper?.update) selectionHelper.update();
    updateLabels();
    renderer.render(scene, camera);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    window.requestAnimationFrame(updateResponsiveQa);
  }

  function updateResponsiveQa() {
    const toolbar = document.getElementById("unified-toolbar");
    const rail = document.getElementById("quick-action-rail");
    if (!toolbar || !rail) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const railStyle = window.getComputedStyle(rail);
    const portrait = window.matchMedia("(max-width: 640px) and (orientation: portrait)").matches;
    window.WUJIE_RUNTIME_QA = Object.assign(window.WUJIE_RUNTIME_QA || {}, {
      responsive: {
        mobilePortrait: portrait,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentFitsViewport: document.documentElement.scrollWidth <= window.innerWidth + 1,
        toolbarBottom: Math.round(toolbarRect.bottom),
        toolbarHeight: Math.round(toolbarRect.height),
        toolbarClosed: toolbar.classList.contains("closed"),
        quickRailTop: Math.round(railRect.top),
        quickRailBottom: Math.round(railRect.bottom),
        quickRailDirection: railStyle.flexDirection,
        quickRailOverflowX: railStyle.overflowX,
      },
    });
  }
})();
