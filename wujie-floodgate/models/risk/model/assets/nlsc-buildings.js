/* NLSC 3D Tiles 1.1 online adapter. Reads only visible AOI tiles into memory.
 * Geometry/metadata: NLSC; code: this project. No texture redistribution.
 * Supports uncompressed GLB POSITION + indices + EXT_mesh_features metadata;
 * fails explicitly on compressed/sparse or unsupported geometry. */
(function (global) {
  "use strict";
  const ENDPOINT = "https://3dtiles.nlsc.gov.tw/building/tiles3d/36/tileset.json";
  const ORIGIN = [-3058323.1709912075,4926224.690877459,2648082.6297668274];
  const A=6378137, F=1/298.257222101, E2=F*(2-F), K=.9999;
  function projectECEF(x,y,z) {
    const lon=Math.atan2(y,x), p=Math.hypot(x,y);
    let lat=Math.atan2(z,p*(1-E2)), N;
    for(let i=0;i<7;i++){N=A/Math.sqrt(1-E2*Math.sin(lat)**2);lat=Math.atan2(z+E2*N*Math.sin(lat),p);}
    N=A/Math.sqrt(1-E2*Math.sin(lat)**2);
    const h=p/Math.cos(lat)-N, e4=E2**2,e6=E2**3, ep=E2/(1-E2);
    const T=Math.tan(lat)**2,C=ep*Math.cos(lat)**2,D=(lon-121*Math.PI/180)*Math.cos(lat);
    const M=A*((1-E2/4-3*e4/64-5*e6/256)*lat-(3*E2/8+3*e4/32+45*e6/1024)*Math.sin(2*lat)+(15*e4/256+45*e6/1024)*Math.sin(4*lat)-35*e6/3072*Math.sin(6*lat));
    return [250000+K*N*(D+(1-T+C)*D**3/6+(5-18*T+T*T+72*C-58*ep)*D**5/120),
      K*(M+N*Math.tan(lat)*(D*D/2+(5-T+9*C+4*C*C)*D**4/24+(61-58*T+T*T+600*C-330*ep)*D**6/720)),h];
  }
  function parseGLB(buffer) {
    const d=new DataView(buffer);
    if(d.getUint32(0,true)!==0x46546c67||d.getUint32(4,true)!==2) throw Error("不支援的GLB版本");
    let json,bin;
    for(let p=12;p<buffer.byteLength;){
      const n=d.getUint32(p,true),type=d.getUint32(p+4,true);p+=8;
      if(type===0x4e4f534a)json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,p,n)));
      if(type===0x004e4942)bin=new Uint8Array(buffer,p,n);p+=n;
    }
    if(!json||!bin)throw Error("GLB缺少JSON或幾何");
    function accessor(index) {
      const a=json.accessors[index],v=json.bufferViews[a.bufferView];
      if(a.sparse||v.extensions?.EXT_meshopt_compression)throw Error("壓縮／稀疏格式尚未支援");
      const types={5120:["getInt8",1],5121:["getUint8",1],5122:["getInt16",2],5123:["getUint16",2],5125:["getUint32",4],5126:["getFloat32",4]};
      const [fn,size]=types[a.componentType]||[],n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
      if(!fn||!n)throw Error("不支援的屬性型態");
      const view=new DataView(bin.buffer,bin.byteOffset,bin.byteLength),out=[];
      for(let i=0;i<a.count;i++){const row=[];for(let c=0;c<n;c++)row.push(view[fn]((v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||n*size)+c*size,true));out.push(n===1?row[0]:row);}
      return out;
    }
    const tables=(json.extensions?.EXT_structural_metadata?.propertyTables||[]).map(t=>{
      const rows=Array.from({length:t.count},()=>({}));
      for(const [key,p] of Object.entries(t.properties||{})){
        if(p.stringOffsets===undefined)continue;
        const sv=json.bufferViews[p.stringOffsets],vv=json.bufferViews[p.values];
        const view=new DataView(bin.buffer,bin.byteOffset+(sv.byteOffset||0),sv.byteLength);
        for(let i=0;i<t.count;i++){const start=view.getUint32(i*4,true),end=view.getUint32((i+1)*4,true);rows[i][key]=new TextDecoder().decode(bin.subarray((vv.byteOffset||0)+start,(vv.byteOffset||0)+end));}
      }return rows;
    });
    return {json,accessor,tables};
  }
  function intersectsTriangleRect(t,x0,y0,x1,y1) {
    if(Math.max(t[0][0],t[1][0],t[2][0])<x0||Math.min(t[0][0],t[1][0],t[2][0])>x1||
       Math.max(t[0][1],t[1][1],t[2][1])<y0||Math.min(t[0][1],t[1][1],t[2][1])>y1)return false;
    // Separating axis theorem: rectangle axes checked above, then triangle edge normals.
    const r=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
    for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],nx=-(b[1]-a[1]),ny=b[0]-a[0];
      if(Math.abs(nx)+Math.abs(ny)<1e-8)continue;
      const tp=t.map(p=>p[0]*nx+p[1]*ny),rp=r.map(p=>p[0]*nx+p[1]*ny);
      if(Math.max(...tp)<Math.min(...rp)-1e-7||Math.max(...rp)<Math.min(...tp)-1e-7)return false;}
    return true;
  }
  class NlscBuildings {
    constructor(options) {
      Object.assign(this,options);
      this.group=new THREE.Group();this.group.name="NLSC-official-buildings";
      this.records=new Map();this.loaded=new Map();this.pending=new Set();this.failed=new Set();
      this.candidates=[];this.status="CONNECTING_ROOT";this.enabled=true;this.lastUpdate=0;this.onChangePending=false;
      this.generation=0;this.maxTiles=48;this.activeRequests=0;
      this.root();
    }
    notify() { this.onStatus?.({status:this.status,tiles:this.loaded.size,buildings:this.records.size,failed:this.failed.size,pending:this.pending.size,endpoint:ENDPOINT}); }
    async root() {
      this.status="CONNECTING_ROOT";this.notify();
      try{
        const r=await fetch(ENDPOINT,{signal:AbortSignal.timeout(30000)});
        if(!r.ok)throw Error("根索引HTTP "+r.status);
        const json=await r.json();this.candidates=[];
        const walk=(t,parentTransform=new THREE.Matrix4())=>{
          const s=t.boundingVolume?.sphere;if(!s||s[3]<=0)return;
          if(Math.hypot(...s.slice(0,3).map((v,i)=>v-ORIGIN[i]))-s[3]>11500)return;
          const children=(t.children||[]).filter(c=>c.boundingVolume?.sphere?.[3]>0);
          const contents=t.contents||[t.content].filter(Boolean);
          const [e,n]=projectECEF(...s.slice(0,3));
          if(e+s[3]<this.extent.xmin||e-s[3]>this.extent.xmax||n+s[3]<this.extent.ymin||n-s[3]>this.extent.ymax)return;
          const transform=parentTransform.clone();if(t.transform)transform.multiply(new THREE.Matrix4().fromArray(t.transform));
          const entry={e,n,r:s[3],tiles:[],children:children.map(child=>walk(child,transform)).filter(Boolean)};
          for(const c of contents){const uri=c.uri||c.url;if(!uri)continue;
            const tile={url:new URL(uri,ENDPOINT).href,e,n,r:s[3],transform:transform.toArray()};entry.tiles.push(tile);this.candidates.push(tile);}
          return entry;
        };
        this.tree=walk(json.root);this.status="ROOT_CONNECTED";this.notify();
      }catch(e){this.status=e.name==="TimeoutError"?"TIMEOUT":"FAILED";this.error=String(e);this.notify();}
    }
    retry(){this.failed.clear();if(!this.candidates.length)this.root();else this.lastUpdate=0;}
    update(now,camera,target) {
      if(!this.enabled||!this.candidates.length||now-this.lastUpdate<900)return;
      this.lastUpdate=now;
      const e=target.x+this.center.e,n=this.center.n-target.z;
      const targetRadius=Math.max(65,Math.min(1800,camera.position.distanceTo(target)*.075));
      const visibleRadius=Math.max(450,camera.position.distanceTo(target)*.7);
      const candidates=[];
      const select=node=>{
        if(!node||Math.hypot(node.e-e,node.n-n)-node.r>visibleRadius)return;
        if(node.children.length&&(!node.tiles.length||node.r>targetRadius)){node.children.forEach(select);return;}
        candidates.push(...node.tiles);
      };
      select(this.tree);
      const near=candidates.sort((a,b)=>Math.hypot(a.e-e,a.n-n)-Math.hypot(b.e-e,b.n-n)).slice(0,this.maxTiles);
      const wanted=new Set(near.map(t=>t.url));
      this.wanted=wanted;
      for(const [url,t] of this.loaded)if(!wanted.has(url)){
        t.meshes.forEach(m=>{this.group.remove(m);m.geometry.dispose();m.material.dispose();});
        t.ids.forEach(id=>this.records.delete(id));this.loaded.delete(url);this.onChangePending=true;
      }
      for(const t of near) {
        if(this.activeRequests>=3)break;
        if(this.loaded.has(t.url)||this.pending.has(t.url)||this.failed.has(t.url))continue;
        this.loadTile(t);
      }
      if(this.onChangePending){this.onChangePending=false;this.onChange?.();}
      this.notify();
    }
    async loadTile(tile) {
      this.pending.add(tile.url);this.activeRequests++;
      try {
        const r=await fetch(tile.url,{signal:AbortSignal.timeout(20000)});
        if(!r.ok)throw Error("內容HTTP "+r.status);
        const buffer=await r.arrayBuffer();
        if(!this.enabled||!this.wanted?.has(tile.url))return;
        const parsed=parseGLB(buffer);
        const result=this.makeMeshes(parsed,tile);
        this.loaded.set(tile.url,result);
        result.meshes.forEach(m=>this.group.add(m));
        this.status="VISIBLE_TILE_RECEIVED";this.onChangePending=true;
      }catch(e){this.failed.add(tile.url);this.error=String(e);this.status=this.records.size?"PARTIAL":"FAILED";}
      finally{this.pending.delete(tile.url);this.activeRequests--;this.notify();}
    }
    makeMeshes({json,accessor,tables},tile) {
      const output={meshes:[],ids:[],ranges:[]},features=new Map(),vec=new THREE.Vector3(),combined=[],edgePositions=[];
      const up=new THREE.Matrix4().makeRotationX(Math.PI/2);
      const tileMatrix=tile.transform?new THREE.Matrix4().fromArray(tile.transform):new THREE.Matrix4();
      function visit(index,parent) {
        const node=json.nodes[index],local=new THREE.Matrix4();
        if(node.matrix)local.fromArray(node.matrix);
        else local.compose(new THREE.Vector3(...(node.translation||[0,0,0])),new THREE.Quaternion(...(node.rotation||[0,0,0,1])),new THREE.Vector3(...(node.scale||[1,1,1])));
        const matrix=parent.clone().multiply(local);
        if(node.mesh!==undefined)for(const primitive of json.meshes[node.mesh].primitives){
          if((primitive.mode??4)!==4||primitive.extensions?.KHR_draco_mesh_compression)throw Error("不支援的壓縮／非三角網");
          const position=accessor(primitive.attributes.POSITION);
          const ft=primitive.extensions?.EXT_mesh_features?.featureIds?.[0];
          if(!ft||ft.attribute===undefined)throw Error("圖磚未回傳可辨識單棟屬性");
          const ids=accessor(primitive.attributes["_FEATURE_ID_"+ft.attribute]),attrs=tables[ft.propertyTable];
          const indices=primitive.indices===undefined?position.map((_,i)=>i):accessor(primitive.indices);
          const projected=position.map(p=>{vec.fromArray(p).applyMatrix4(matrix).applyMatrix4(up).applyMatrix4(tileMatrix);return projectECEF(vec.x,vec.y,vec.z);});
          for(let i=0;i<indices.length;i+=3){
            const ai=indices[i],bi=indices[i+1],ci=indices[i+2],f=ids[ai],attr=attrs?.[f];
            if(!attr)throw Error("缺少單棟metadata");
            const id=attr.BUILD_ID||attr.MODEL_NAME;
            if(!id)throw Error("缺少官方模型識別码");
            let item=features.get(id);if(!item){item={attr,triangles:[]};features.set(id,item);}
            const points=[projected[ai],projected[bi],projected[ci]];
            item.triangles.push(points);
          }
        }
        (node.children||[]).forEach(i=>visit(i,matrix));
      }
      (json.scenes?.[json.scene||0]?.nodes||[0]).forEach(i=>visit(i,new THREE.Matrix4()));
      // The offline importer consumes every projected feature before view/DTM filtering.
      this.onProjectedFeatures?.(features,tile);
      if(this.extractOnly)return output;
      for(const [officialId,item] of features){
        const a=item.attr,id="NLSC3D-"+officialId;if(this.records.has(id))continue;
        const e=Number(a.CENT_E_97),n=Number(a.CENT_N_97);
        if(!Number.isFinite(e)||!Number.isFinite(n)||e<this.extent.xmin||e>this.extent.xmax||n<this.extent.ymin||n>this.extent.ymax)continue;
        const ground=this.ground(e,n);if(!Number.isFinite(ground))continue;
        const positions=[],cells=new Set();let low=Infinity,high=-Infinity,minE=Infinity,maxE=-Infinity,minN=Infinity,maxN=-Infinity;
        item.triangles.forEach(t=>{
          t.forEach(p=>{positions.push(p[0]-this.center.e,p[2]-this.datum,this.center.n-p[1]);low=Math.min(low,p[2]);high=Math.max(high,p[2]);minE=Math.min(minE,p[0]);maxE=Math.max(maxE,p[0]);minN=Math.min(minN,p[1]);maxN=Math.max(maxN,p[1]);});
          const c0=Math.floor((Math.min(...t.map(p=>p[0]))-this.grid.xmin)/this.cell),c1=Math.floor((Math.max(...t.map(p=>p[0]))-this.grid.xmin)/this.cell);
          const r0=Math.floor((Math.min(...t.map(p=>p[1]))-this.grid.ymin)/this.cell),r1=Math.floor((Math.max(...t.map(p=>p[1]))-this.grid.ymin)/this.cell);
          for(let row=r0;row<=r1;row++)for(let col=c0;col<=c1;col++){const x=this.grid.xmin+col*this.cell,y=this.grid.ymin+row*this.cell;if(intersectsTriangleRect(t,x,y,x+this.cell,y+this.cell))cells.add(row+":"+col);}
        });
        const storeys=Number(a.BUILD_NO),modelHeight=Number(a.BUILD_H);
        const building={id,name:a.BUILDNAME&&!/^(NA|NULL|NONE)$/i.test(a.BUILDNAME)?a.BUILDNAME:"NLSC建物 "+officialId,e,n,groundElev:ground,
          officialId,officialAttributes:a,officialStoreys:a.BUILD_NO&&Number.isFinite(storeys)&&storeys>0?storeys:null,
          officialStoreysStatus:"NLSC BUILD_NO；NO_SOURCE代碼："+(a.NO_SOURCE||"未填")+"（代碼釋義待核對）",
          officialStoreysBasis:"NLSC分棟版BUILD_NO／NO_SOURCE（不等同建照使照）",
          height:Number.isFinite(modelHeight)&&modelHeight>0?modelHeight:high-low,modelHeightM:high-low,
          groundElevBasis:"2025版20m DTM；與官方模型底部高程分開",
          officialModelMinHeightM:low,verticalDifferenceM:low-ground,
          width:maxE-minE,depth:maxN-minN,areaM2:null,
          footprintSource:"NLSC官方3D三角網垂直投影（非宗地／室內面積）",
          floodCellKeys:Array.from(cells),geometryClass:"NLSC_OFFICIAL_3DTILES",
          source:"內政部國土測繪中心宜蘭縣分棟版3D Tiles",
          citation:tile.url,sourceUrl:tile.url,sourceDate:a.MDATE,modelDate:a.M_MDATE,modelLod:a.MODEL_LOD,
          materialSourceClass:"USER_WHITE_RISK_RED",materialBasis:"白模；連通外溢風險按水深漸進染紅",
          facadeColor:"#ffffff",roofColor:"#ffffff",heightBasis:"官方3D網格與BUILD_H，非由樓層估高",
          riskQaStatus:Math.abs(low-ground)>5?"VERTICAL_DIFFERENCE_REVIEW":"SCREENING_ONLY"};
        // One draw call per tile. Keep separate feature state for picking, census and risk colours.
        const m={visible:true,material:{color:new THREE.Color("#ffffff")},userData:{kind:"official-building",building}};
        const start=combined.length;for(const v of positions)combined.push(v);
        const edgeStart=edgePositions.length;
        const featureGeometry=new THREE.BufferGeometry();
        featureGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
        const edges=new THREE.EdgesGeometry(featureGeometry,25);
        for(const value of edges.attributes.position.array)edgePositions.push(value);
        edges.dispose();featureGeometry.dispose();
        output.ranges.push({id,start,count:positions.length,edgeStart,edgeCount:edgePositions.length-edgeStart,lastColor:null,lastVisible:true});
        this.records.set(id,{building,mesh:m,lod:"NLSC官方3D（"+(a.MODEL_LOD||"未列LOD")+"）"});
        output.ids.push(id);
      }
      if(combined.length){
        const geometry=new THREE.BufferGeometry(),vertices=new Float32Array(combined),colours=new Float32Array(combined.length).fill(1);
        geometry.setAttribute("position",new THREE.BufferAttribute(vertices,3));geometry.setAttribute("color",new THREE.BufferAttribute(colours,3));geometry.computeVertexNormals();
        const batch=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:"#ffffff",vertexColors:true,side:THREE.DoubleSide,toneMapped:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
        batch.userData={kind:"official-building-batch",ranges:output.ranges};batch.name=tile.url;
        // Stable soft face shading independent of renderer exposure/light settings.
        // Keep proxy colours unshaded for risk accounting; tint the actual vertices.
        const normals=geometry.attributes.normal.array,shades=new Float32Array(vertices.length/3);
        const light=new THREE.Vector3(-.4,1,.6).normalize();
        for(let v=0;v<shades.length;v++){
          const i=v*3,upFace=Math.abs(normals[i+1]);
          const sideLight=Math.abs(normals[i]*light.x+normals[i+2]*light.z);
          shades[v]=Math.min(1,.60+.37*upFace+.20*sideLight);
        }
        output.shades=shades;output.meshes.push(batch);output.basePositions=vertices.slice();
        const edgeGeometry=new THREE.BufferGeometry();
        const edgeVertices=new Float32Array(edgePositions);
        edgeGeometry.setAttribute('position',new THREE.BufferAttribute(edgeVertices,3));
        const outline=new THREE.LineSegments(edgeGeometry,new THREE.LineBasicMaterial({color:'#536777',transparent:true,opacity:.7,toneMapped:false,depthWrite:false}));
        outline.name='NLSC-building-contours';outline.userData.kind='building-contours';
        outline.raycast=()=>{}; // Contours must not intercept building selection.
        outline.visible=this.contoursVisible!==false;outline.renderOrder=2;
        output.meshes.push(outline);output.baseEdgePositions=edgeVertices.slice();
      }
      return output;
    }
    flushColors(){
      for(const tile of this.loaded.values()){
        const g=tile.meshes[0]?.geometry;if(!g)continue;
        let colorChanged=false,positionChanged=false;
        for(const range of tile.ranges){
          const record=this.records.get(range.id);if(!record)continue;
          const {mesh}=record,color=mesh.material.color,key=color.r+","+color.g+","+color.b;
          if(key!==range.lastColor){
            for(let i=range.start;i<range.start+range.count;i+=3){const shade=tile.shades[i/3];g.attributes.color.array[i]=color.r*shade;g.attributes.color.array[i+1]=color.g*shade;g.attributes.color.array[i+2]=color.b*shade;}
            range.lastColor=key;colorChanged=true;
          }
          if(mesh.visible!==range.lastVisible){
            for(let i=range.start;i<range.start+range.count;i++)g.attributes.position.array[i]=mesh.visible?tile.basePositions[i]:0;
            const edgeAttribute=tile.meshes[1]?.geometry.attributes.position;
            if(edgeAttribute)for(let i=range.edgeStart;i<range.edgeStart+range.edgeCount;i++)edgeAttribute.array[i]=mesh.visible?tile.baseEdgePositions[i]:0;
            range.lastVisible=mesh.visible;positionChanged=true;
          }
        }
        if(colorChanged)g.attributes.color.needsUpdate=true;
        if(positionChanged){
          g.attributes.position.needsUpdate=true;g.computeBoundingSphere();
          const eg=tile.meshes[1]?.geometry;if(eg){eg.attributes.position.needsUpdate=true;eg.computeBoundingSphere();}
        }
      }
    }
    setContoursVisible(visible) {
      this.contoursVisible=visible;
      for(const tile of this.loaded.values())if(tile.meshes[1])tile.meshes[1].visible=visible;
    }
    resolveHit(hit){
      if(!Number.isInteger(hit.faceIndex))return null;
      const vertex=hit.faceIndex*9;
      const range=hit.object.userData.ranges?.find(r=>vertex>=r.start&&vertex<r.start+r.count);
      const record=range&&this.records.get(range.id);
      return record?.mesh.visible?{kind:"official-building",data:record.building,instanceId:null}:null;
    }
  }
  global.WujieNlsc={NlscBuildings,projectECEF,parseGLB,intersectsTriangleRect,endpoint:ENDPOINT};
})(typeof window!=="undefined"?window:globalThis);
