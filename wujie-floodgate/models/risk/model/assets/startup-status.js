(function () {
  "use strict";
  function showFailure(message) {
    const card = document.getElementById("webgl-error");
    if (!card) return;
    document.getElementById("loading")?.classList.add("ready");
    card.hidden = false;
    card.querySelector("p").textContent = message;
  }
  window.addEventListener("error", function (event) {
    const asset = event.target;
    if (asset && asset.tagName === "SCRIPT") {
      showFailure("模型元件載入失敗，請重新載入網頁。");
    } else if (!document.getElementById("app")?.dataset.sceneReady) {
      showFailure("模型啟動中斷，請重新載入；若仍無法顯示，請通知製作者。");
    }
  }, true);
  window.addEventListener("unhandledrejection", function () {
    if (!document.getElementById("app")?.dataset.sceneReady) {
      showFailure("模型資料未完成載入，請重新載入網頁。");
    }
  });
  document.getElementById("scene-canvas")?.addEventListener("webglcontextlost", function () {
    showFailure("瀏覽器已中止3D繪圖，請關閉其他3D頁面後重新載入。");
  });
})();
