/* Fixed, explicitly partial analysis cohorts. No network requests or 3D cache. */
(function (global) {
  'use strict';
  class BuildingCensus {
    constructor(extent, grid) { this.extent={...extent}; this.grid={...grid}; this.records=new Map(); this.revision=0; this.capturedAt=null; }
    capture(records) {
      if(this.fullManifest)throw Error('全區固定清冊不能混入鏡頭樣本。');
      const next=new Map(this.records);
      for(const {building,lod} of records.values()) {
        if(!building.officialId || next.has(building.id) || !this.inside(building)) continue;
        next.set(building.id,{building:JSON.parse(JSON.stringify(building)),lod});
      }
      this.records=next; this.revision++; this.capturedAt=new Date().toISOString();
    }
    inside(b) { return [b.e,b.n,b.groundElev].every(Number.isFinite) && b.e>=this.extent.xmin && b.e<=this.extent.xmax && b.n>=this.extent.ymin && b.n<=this.extent.ymax; }
    describe(items=Array.from(this.records.values())) {
      const cells=new Set();let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;
      for(const {building:b} of items) {
        xmin=Math.min(xmin,b.e);xmax=Math.max(xmax,b.e);ymin=Math.min(ymin,b.n);ymax=Math.max(ymax,b.n);
        for(const key of b.floodCellKeys||[])cells.add(key);
      }
      const bbox=items.length?{xmin,ymin,xmax,ymax}:null;
      return {count:items.length,crs:'EPSG:3826',centroidBounds:bbox,
        missingGroundCount:items.filter(({building:b})=>!Number.isFinite(b.groundElev)).length,
        centroidEnvelopeHa:bbox?(xmax-xmin)*(ymax-ymin)/10000:0,
        buildingProjectionGridCells:cells.size,buildingProjectionGridHa:cells.size*this.grid.cellSizeM**2/10000,
        gridSizeM:this.grid.cellSizeM,revision:this.revision,capturedAt:this.capturedAt,
        coverage:'AVAILABLE_OBJECTS_ONLY',reportMembership:'NOT_YET_SPATIALLY_VERIFIED',
        definition:'本模型範圍內已取得並固定之NLSC BUILD_ID去重建物集合；座標外包框僅描述分布，並非框內全部建物普查或報告淹水界線。'};
    }
    snapshot(sourceCatalog=[]) {
      if(this.fullManifest)return this.fullManifest;
      return {schema:'WUJIE_FIXED_COHORT_V1',status:'PARTIAL_NOT_AOI_CENSUS',crs:'EPSG:3826',extent:this.extent,grid:this.grid,
        revision:this.revision,capturedAt:this.capturedAt,officialTotal:null,missingCount:null,
        count:this.records.size,sampleCountN:this.records.size,reportPopulationY:null,reportRiskX:null,
        currentModelPopulationY:this.records.size,currentCalculationScope:this.describe(),
        reportImpactScope:global.WUJIE_MODEL_DATA?.reportImpactScope||null,
        sourceCatalog,buildings:Array.from(this.records.values()),
        limitation:'僅本次按需載入並固定的去重樣本；未取得全區官方清冊。不是3D實體模型包，不含網格、紋理或所有權人。'};
    }
    restore(input) {
      if(input?.schema!=='WUJIE_FIXED_COHORT_V1'||input.crs!=='EPSG:3826'||!Array.isArray(input.buildings)||input.buildings.length>250000) throw Error('不是本模型固定樣本JSON；官方原始檔須先轉換及驗證。');
      for(const key of ['xmin','xmax','ymin','ymax']) if(input.extent?.[key]!==this.extent[key]) throw Error('樣本範圍與本模型不一致。');
      for(const [key,value] of Object.entries(this.grid)) if(input.grid?.[key]!==value) throw Error('樣本格網版本不一致，須重新相交。');
      const next=new Map();
      for(const item of input.buildings) {
        const b=item?.building;
        if(!b || typeof b.officialId!=='string' || b.id!=='NLSC3D-'+b.officialId || !this.inside(b) || !Array.isArray(b.floodCellKeys) || !b.floodCellKeys.length || b.floodCellKeys.some(k=>typeof k!=='string'||!/^\d+:\d+$/.test(k))) throw Error('建物識別碼、坐標、高程或格網關聯不完整。');
        if(next.has(b.id)) throw Error('匯入樣本有重複BUILD_ID，請先查明版本。');
        next.set(b.id,JSON.parse(JSON.stringify(item)));
      }
      this.records=next; this.revision=Math.max(this.revision+1,Number.isSafeInteger(input.revision)?input.revision:0); this.capturedAt=input.capturedAt||null;this.fullManifest=null;
    }
    restoreFull(validated) {
      const m=validated.manifest;
      this.records=new Map(m.buildings.map(item=>[item.building.id,{building:item.building,lod:item.lod}]));
      this.fullManifest=m;this.revision++;this.capturedAt=m.createdAt;
    }
  }
  global.WujieBuildingCensus=BuildingCensus;
})(typeof window!=='undefined'?window:globalThis);
