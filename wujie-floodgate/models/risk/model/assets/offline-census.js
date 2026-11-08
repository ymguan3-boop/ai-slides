/* Fixed whole-scope census import. Reads user-selected files only; no network. */
(function(global){
  'use strict';
  function validate(manifest,buffer,extent,grid,center) {
    const m=manifest;
    if(m?.schema!=='WUJIE_OFFLINE_CENSUS_V1'||m.status!=='COMPLETE_FIXED_DATASET'||m.crs!=='EPSG:3826')throw Error('不是已完成檢查的全區離線資料包。');
    if(!['REPORT_ORIGINAL','REPORT_DIGITIZED_REFERENCE'].includes(m.scope?.kind))throw Error('不接受測試或無出處的影響邊界。');
    if(!m.scope?.geometry||!m.scope?.source||!(m.scope.unionAreaHa>0)||!m.version)throw Error('缺影響範圍、面積、出處或固定版本。');
    if(m.regionalDataSha256!==global.WUJIE_OFFLINE_CONTEXT?.regionalDataSha256)throw Error('DTM／河道格網檔版本與本模型不一致，須重新產製清冊。');
    if(m.audit?.missingFiles!==0||m.audit?.coverageUncoveredM2>.01||m.audit?.coverageDeclaration!=='COMPLETE_FOR_COVERAGE'||!(m.audit?.filesVerified>0))throw Error('檔案或涵蓋完整性未通過。');
    for(const k of ['permissionEvidence','coverageEvidence','beforeBoundary','afterBoundary'])if(!m.audit.evidence?.[k]?.sha256)throw Error('缺資料供應／範圍證據：'+k);
    for(const [k,v] of Object.entries(extent))if(m.extent?.[k]!==v)throw Error('模型範圍不一致，須重建離線清冊。');
    for(const [k,v] of Object.entries(grid))if(m.grid?.[k]!==v)throw Error('格網版本不一致，須重算建物相交。');
    if(m.center?.e!==center.e||m.center?.n!==center.n||m.datum!==2)throw Error('模型原點／展示高程基準不一致。');
    if(m.geometry?.format!=='FLOAT32_LE_XYZ_LOCAL'||buffer.byteLength!==m.geometry.floatCount*4||buffer.byteLength>512*1024*1024)throw Error('幾何檔長度或格式不正確。');
    if(!Array.isArray(m.buildings)||m.count!==m.buildings.length||m.count>250000)throw Error('清冊筆數不一致。');
    let end=0,missing=0;const ids=new Set();
    const positions=new Float32Array(buffer);
    if(positions.some(v=>!Number.isFinite(v)))throw Error('幾何含非有限數字。');
    for(const item of m.buildings){const b=item.building;
      if(!b||!b.officialId||b.id!=='NLSC3D-'+b.officialId||ids.has(b.id)||b.inReportScope!==true)throw Error('BUILD_ID重複或範圍歸屬錯誤。');
      if(![b.e,b.n,b.areaM2].every(Number.isFinite)||b.areaM2<=0||!b.footprint)throw Error('建物坐標／水平投影缺漏。');
      if(b.groundElev===null)missing++;else if(!Number.isFinite(b.groundElev))throw Error('DTM缺值請填null，不能填0。');
      if(!Array.isArray(b.floodCellKeys)||b.floodCellKeys.some(k=>typeof k!=='string'||!/^\d+:\d+$/.test(k)))throw Error('缺建物相交格網。');
      if(item.geometryStart!==end||!Number.isInteger(item.geometryCount)||item.geometryCount<9||item.geometryCount%9!==0)throw Error('建物幾何範圍重疊或缺漏。');
      end+=item.geometryCount;ids.add(b.id);
    }
    if(end!==positions.length||m.missingGroundCount!==missing)throw Error('幾何／高程缺值對帳不一致。');
    return {manifest:m,positions};
  }
  async function loadFiles(files,extent,grid,center) {
    const list=Array.from(files),json=list.find(f=>f.name==='census.json'),bin=list.find(f=>f.name==='positions.bin');
    if(!json||!bin||list.length!==2)throw Error('請同時選取同一版本的census.json與positions.bin兩個檔案。');
    if(json.size>150*1024*1024||bin.size>512*1024*1024)throw Error('資料包過大，需先分批優化顯示；不能截減統計範圍。');
    const m=JSON.parse(await json.text()),buffer=await bin.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==m.geometry?.sha256)throw Error('幾何檔雜湊不一致，不能混用不同版本。');
    return validate(m,buffer,extent,grid,center);
  }
  class OfflineBuildings {
    constructor(validated) {
      this.isOffline=true;this.enabled=true;this.group=new THREE.Group();this.group.name='NLSC-fixed-offline-buildings';
      this.records=new Map();this.loaded=new Map();this.manifest=validated.manifest;
      const items=validated.manifest.buildings,all=validated.positions;
      // Multiple moderate-size draw batches; census always contains ALL records.
      for(let from=0;from<items.length;from+=256){
        const chunk=items.slice(from,from+256),first=chunk[0].geometryStart,last=chunk.at(-1),positions=all.slice(first,last.geometryStart+last.geometryCount);
        const ranges=[],edges=[];
        for(const item of chunk){const b=item.building,start=item.geometryStart-first,count=item.geometryCount,edgeStart=edges.length;
          const fg=new THREE.BufferGeometry();fg.setAttribute('position',new THREE.BufferAttribute(positions.slice(start,start+count),3));
          const edge=new THREE.EdgesGeometry(fg,25);for(const v of edge.attributes.position.array)edges.push(v);edge.dispose();fg.dispose();
          ranges.push({id:b.id,start,count,edgeStart,edgeCount:edges.length-edgeStart,lastColor:null,lastVisible:true});
          this.records.set(b.id,{building:b,lod:item.lod,mesh:{visible:true,material:{color:new THREE.Color('#ffffff')},userData:{kind:'official-building',building:b}}});
        }
        const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(positions.length).fill(1),3));geo.computeVertexNormals();
        const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:'#ffffff',vertexColors:true,side:THREE.DoubleSide,toneMapped:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
        mesh.userData={kind:'official-building-batch',ranges};
        const edgeGeo=new THREE.BufferGeometry();const edgePos=new Float32Array(edges);edgeGeo.setAttribute('position',new THREE.BufferAttribute(edgePos,3));
        const outline=new THREE.LineSegments(edgeGeo,new THREE.LineBasicMaterial({color:'#536777',transparent:true,opacity:.7,toneMapped:false,depthWrite:false}));outline.raycast=()=>{};outline.renderOrder=2;
        const normals=geo.attributes.normal.array,shades=new Float32Array(positions.length/3);for(let i=0;i<shades.length;i++)shades[i]=Math.min(1,.60+.37*Math.abs(normals[i*3+1])+.16*Math.abs(normals[i*3])+.12*Math.abs(normals[i*3+2]));
        const batch={meshes:[mesh,outline],ranges,shades,basePositions:positions.slice(),baseEdgePositions:edgePos.slice(),ids:chunk.map(i=>i.building.id)};
        this.loaded.set(String(from),batch);this.group.add(mesh,outline);
      }
      this.flushColors();
    }
    update(){} // Camera movement never fetches, removes, or changes the population.
    retry(){}
    flushColors(){return WujieNlsc.NlscBuildings.prototype.flushColors.call(this);}
    resolveHit(hit){return WujieNlsc.NlscBuildings.prototype.resolveHit.call(this,hit);}
    setContoursVisible(v){return WujieNlsc.NlscBuildings.prototype.setContoursVisible.call(this,v);}
  }
  global.WujieOfflineCensus={validate,loadFiles,OfflineBuildings};
})(typeof window!=='undefined'?window:globalThis);
