(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WujieFlowEvent=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  // Explicit user-selected demonstration assumptions, NOT a calibrated hydraulic model.
  const config=Object.freeze({version:'20260906-flow-v16',startFlowCms:100,thresholdCms:750,maximumFlowCms:1088,startLevelM:1,riseHours:6,travelSpeedMps:0.5,cellSizeM:40,playbackSeconds:24,quality:'USER_ASSUMED_SCREENING'});
  const qNodes=[100,750,775,1088],tNodes=[0,2,3,6];
  const hNodes={after:[1,2.46,2.79,2.92],before:[1,2.889233226837061,2.91,3.17]};
  function interpolate(value,x,y){if(value<=x[0])return y[0];for(let i=1;i<x.length;i++)if(value<=x[i])return y[i-1]+(value-x[i-1])*(y[i]-y[i-1])/(x[i]-x[i-1]);return y[y.length-1];}
  const level=(q,construction='after')=>interpolate(q,qNodes,hNodes[construction]);
  const flowAtHours=hours=>interpolate(hours,tNodes,qNodes);
  const hoursAtFlow=q=>q>1088?Infinity:interpolate(q,qNodes,tNodes);
  function flowAtLevel(h,construction='after'){const hs=hNodes[construction];return h>hs[3]?Infinity:interpolate(h,hs,qNodes);}
  function onset(requiredLevel,arrivalCells,construction='after'){
    if(!Number.isFinite(requiredLevel)||!Number.isFinite(arrivalCells)||arrivalCells<0)return {flowCms:null,hours:null};
    let q=flowAtLevel(requiredLevel,construction);
    if(construction==='after')q=Math.max(750.001,q);
    if(!Number.isFinite(q))return {flowCms:null,hours:null};
    const hours=hoursAtFlow(q)+arrivalCells*40/(config.travelSpeedMps*3600);
    return {flowCms:q,hours,arrivalFlowCms:flowAtHours(hours)};
  }
  const endHours=maximumArrivalCells=>6+Math.max(0,maximumArrivalCells)*40/(config.travelSpeedMps*3600);
  const explanation='使用者指定：新閘門通洪門檻假設750 cms，超過才啟動外溢；非核定最大容量。示意起始100 cms／EL1.0m，非實測正常流量；第2／3／6小時達750／775／1088 cms，再維持峰值供網格傳播。H–Q採分段線性展示轉換：750操作峰與775一般通洪非同工況，不是報告率定曲線。到達時間=達所需流量時間＋格網連通距離÷假設0.5m/s；非實際洪水預報。';
  function presentation({hours,playing,paused,eventActive,spilling}){
    const complete=Number.isFinite(hours)&&!playing&&!paused&&!eventActive;
    return {complete,timeLabel:complete?'最終成果':Number.isFinite(hours)?hours.toFixed(2)+' 小時'+(paused?'（暫停）':''):'情境預覽',spillLabel:complete?'':spilling?'開始溢堤':'未啟動外溢',raining:Boolean(playing)};
  }
  return {config,level,flowAtHours,hoursAtFlow,flowAtLevel,onset,endHours,explanation,presentation};
});
