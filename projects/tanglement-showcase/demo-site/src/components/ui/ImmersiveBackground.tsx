'use client';

import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

/**
 * Immersive Background Component
 *
 * WebGL-based animated background inspired by Immersive Garden
 * Features layered particle systems, gradient meshes, and smooth animations
 */

export interface ImmersiveBackgroundProps {
  /** Custom className */
  className?: string;
  /** Particle count */
  particleCount?: number;
  /** Animation speed multiplier */
  speed?: number;
}

export function ImmersiveBackground({
  className = '',
  particleCount = 300,
  speed = 1,
}: ImmersiveBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const particlesRef = useRef<THREE.Points | null>(null);
  const particles2Ref = useRef<THREE.Points | null>(null);
  const frameIdRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    // Setup
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 30;
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Create multiple particle layers for depth
    const createParticleLayer = (count: number, spreadFactor: number, sizeFactor: number, opacityVal: number) => {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);

      // Enhanced color palette with more variation
      const colorPalette = [
        new THREE.Color(0x1a3a52), // Lighter deep blue
        new THREE.Color(0x7d75ff), // Brighter purple
        new THREE.Color(0x00e5ff), // Brighter cyan
        new THREE.Color(0x4466ff), // Mid blue
        new THREE.Color(0x00b8d4), // Teal
      ];

      for (let i = 0; i < count; i++) {
        // Distribute particles in 3D space
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI * 2;
        const radius = Math.random() * spreadFactor;

        positions[i * 3] = radius * Math.sin(theta) * Math.cos(phi);
        positions[i * 3 + 1] = radius * Math.sin(theta) * Math.sin(phi);
        positions[i * 3 + 2] = radius * Math.cos(theta);

        // Random color from palette
        const color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const material = new THREE.PointsMaterial({
        size: sizeFactor,
        vertexColors: true,
        transparent: true,
        opacity: opacityVal,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
      });

      return new THREE.Points(geometry, material);
    };

    // Create two particle layers
    const particles1 = createParticleLayer(particleCount, 60, 1.2, 0.9);
    const particles2 = createParticleLayer(Math.floor(particleCount / 2), 40, 2.0, 0.6);

    scene.add(particles1);
    scene.add(particles2);
    particlesRef.current = particles1;
    particles2Ref.current = particles2;

    // Add subtle fog
    scene.fog = new THREE.FogExp2(0x000000, 0.008);

    // Animation
    let time = 0;
    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);

      time += 0.001 * speed;

      // Animate first particle layer
      if (particlesRef.current) {
        particlesRef.current.rotation.y = time * 0.08;
        particlesRef.current.rotation.x = Math.sin(time * 0.03) * 0.15;

        const positions = particlesRef.current.geometry.attributes.position;
        const posArray = positions.array as Float32Array;

        for (let i = 0; i < particleCount; i++) {
          const i3 = i * 3;
          // Complex wave patterns
          posArray[i3] += Math.sin(time * 0.5 + i * 0.1) * 0.015;
          posArray[i3 + 1] += Math.cos(time * 0.3 + i * 0.05) * 0.02;
          posArray[i3 + 2] += Math.sin(time * 0.4 + i * 0.08) * 0.01;
        }
        positions.needsUpdate = true;
      }

      // Animate second particle layer (counter-rotation for depth)
      if (particles2Ref.current) {
        particles2Ref.current.rotation.y = -time * 0.05;
        particles2Ref.current.rotation.x = Math.cos(time * 0.04) * 0.1;

        const positions2 = particles2Ref.current.geometry.attributes.position;
        const pos2Array = positions2.array as Float32Array;
        const count2 = Math.floor(particleCount / 2);

        for (let i = 0; i < count2; i++) {
          const i3 = i * 3;
          pos2Array[i3] += Math.cos(time * 0.4 + i * 0.15) * 0.025;
          pos2Array[i3 + 1] += Math.sin(time * 0.35 + i * 0.1) * 0.015;
          pos2Array[i3 + 2] += Math.cos(time * 0.3 + i * 0.12) * 0.018;
        }
        positions2.needsUpdate = true;
      }

      // Enhanced camera movement
      if (cameraRef.current) {
        cameraRef.current.position.x = Math.sin(time * 0.15) * 3;
        cameraRef.current.position.y = Math.cos(time * 0.1) * 2;
        cameraRef.current.position.z = 30 + Math.sin(time * 0.08) * 5;
        cameraRef.current.lookAt(0, 0, 0);
      }

      renderer.render(scene, camera);
    };

    animate();

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;

      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;

      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    };

    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameIdRef.current);

      if (rendererRef.current) {
        container.removeChild(rendererRef.current.domElement);
        rendererRef.current.dispose();
      }

      // Dispose particle geometries and materials
      if (particlesRef.current) {
        particlesRef.current.geometry.dispose();
        (particlesRef.current.material as THREE.Material).dispose();
      }
      if (particles2Ref.current) {
        particles2Ref.current.geometry.dispose();
        (particles2Ref.current.material as THREE.Material).dispose();
      }
    };
  }, [particleCount, speed]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 ${className}`}
      style={{
        opacity: 0.7,
        transition: 'opacity 2s cubic-bezier(0.445, 0.05, 0.55, 0.95)',
        pointerEvents: 'none',
      }}
    />
  );
}
