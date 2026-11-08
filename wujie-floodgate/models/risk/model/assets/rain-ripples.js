(function(root){
  'use strict';
  // Visual rain impacts only. This pool never changes water levels or risk calculations.
  class RainRipples {
    constructor(T,parent,surfaceAt){
      this.T=T;this.surfaceAt=surfaceAt;this.pool=[];this.anchor=new T.Vector3(Infinity,0,0);
      this.group=new T.Group();this.group.name='rain-water-impacts';parent.add(this.group);
      const geo=new T.RingGeometry(.84,1,24);geo.rotateX(-Math.PI/2);
      this.rings=new T.InstancedMesh(geo,new T.MeshBasicMaterial({color:0x9ce5ff,transparent:true,opacity:.65,depthWrite:false,side:T.DoubleSide}),96);
      this.rings.frustumCulled=false;this.group.add(this.rings);this.dummy=new T.Object3D();
      this.positions=new Float32Array(96*6);const lines=new T.BufferGeometry();lines.setAttribute('position',new T.BufferAttribute(this.positions,3));
      this.drops=new T.LineSegments(lines,new T.LineBasicMaterial({color:0xd9f6ff,transparent:true,opacity:.7,depthWrite:false}));this.drops.frustumCulled=false;this.group.add(this.drops);
      for(let i=0;i<96;i++)this.pool.push({age:Math.random()*2.1,x:0,z:0,y:null});
      this.group.visible=false;
    }
    spawn(p,target,radius){
      p.y=null;
      for(let k=0;k<50;k++){
        const x=target.x+(Math.random()-.5)*radius*2,z=target.z+(Math.random()-.5)*radius*2;
        const y=this.surfaceAt(x,z);
        if(Number.isFinite(y)){p.x=x;p.z=z;p.y=y;return;}
      }
    }
    update(delta,playing,target,distance){
      // Playback is explicitly started by the user; never autoplay water effects.
      this.group.visible=playing;
      if(!this.group.visible)return;
      const radius=Math.max(70,Math.min(2800,distance*.52)),size=Math.max(.7,Math.min(8,distance/450));
      const moved=this.anchor.distanceTo(target)>radius*.4;
      if(moved)this.anchor.copy(target);
      let visible=0;
      this.pool.forEach((p,i)=>{
        p.age+=delta;
        if(moved||p.age>2.1||p.y===null){if(p.age>2.1)p.age=0;this.spawn(p,target,radius);}
        const wet=p.y!==null&&Number.isFinite(this.surfaceAt(p.x,p.z));
        const impact=wet&&p.age>=.6;
        const progress=Math.max(0,(p.age-.6)/1.5),scale=impact?(1+progress*5)*size:0;
        this.dummy.position.set(p.x,p.y||0,p.z);this.dummy.scale.setScalar(scale);this.dummy.updateMatrix();this.rings.setMatrixAt(i,this.dummy.matrix);
        const base=i*6,fall=wet&&p.age<.6;
        const top=(p.y||0)+(1-p.age/.6)*size*14;
        this.positions.set(fall?[p.x,top,p.z,p.x,top+size*2.5,p.z]:[0,0,0,0,0,0],base);
        if(impact)visible++;
      });
      this.rings.instanceMatrix.needsUpdate=true;this.drops.geometry.attributes.position.needsUpdate=true;
      const canvas=document.getElementById('scene-canvas');if(canvas)canvas.dataset.waterRipples=String(visible);
    }
  }
  root.WujieRainRipples=RainRipples;
})(window);
