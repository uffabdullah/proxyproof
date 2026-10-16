"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function BeaconScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 40);
    camera.position.set(0, 0.2, 7.2);

    const group = new THREE.Group();
    scene.add(group);

    const ink = new THREE.MeshStandardMaterial({
      color: 0x1a1410,
      metalness: 0.35,
      roughness: 0.42,
    });
    const coral = new THREE.MeshStandardMaterial({
      color: 0xff4d3a,
      emissive: 0xff4d3a,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 32), coral);
    group.add(core);

    const rings: THREE.Mesh[] = [];
    [1.15, 1.7, 2.25, 2.85].forEach((radius, index) => {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.018, 12, 80),
        index === 1 ? coral : ink,
      );
      mesh.rotation.x = Math.PI / 2.4;
      group.add(mesh);
      rings.push(mesh);
    });

    scene.add(new THREE.AmbientLight(0xfff4ea, 1.4));
    const key = new THREE.PointLight(0xff4d3a, 8, 12);
    key.position.set(2, 2, 3);
    scene.add(key);

    const resize = () => {
      const { width, height } = parent.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);

    let frame = 0;
    const animate = (time: number) => {
      const t = time * 0.001;
      group.rotation.y = t * 0.25;
      group.rotation.z = Math.sin(t * 0.4) * 0.08;
      rings.forEach((ring, index) => {
        ring.rotation.z = t * (0.15 + index * 0.05);
        const scale = 1 + Math.sin(t * 1.6 + index) * 0.025;
        ring.scale.setScalar(scale);
      });
      core.scale.setScalar(1 + Math.sin(t * 2.2) * 0.06);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material.dispose();
        }
      });
    };
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
