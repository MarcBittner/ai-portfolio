'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface FluidBackgroundProps {
  className?: string;
  speed?: number;
}

export function FluidBackground({
  className = '',
  speed = 1.0,
}: FluidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const uniformsRef = useRef<any>(null);
  const mouseRef = useRef({
    target: new THREE.Vector2(0.5, 0.5),
    current: new THREE.Vector2(0.5, 0.5),
  });

  const vertexShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    uniform vec2 uMouse;
    uniform vec2 uResolution;
    uniform float uSpeed;
    uniform float uIntensity;
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    uniform vec3 uColor3;
    uniform float uMouseInfluence;

    varying vec2 vUv;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      float frequency = 1.0;
      for(int i = 0; i < 5; i++) {
        value += amplitude * snoise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
      }
      return value;
    }

    void main() {
      vec2 p = (gl_FragCoord.xy * 2.0 - uResolution) / min(uResolution.x, uResolution.y);
      vec2 mouseInfluence = (uMouse - 0.5) * uMouseInfluence;
      float time = uTime * uSpeed * 0.15;

      vec3 noisePos = vec3(
        p.x * 1.5 + mouseInfluence.x,
        p.y * 1.5 + mouseInfluence.y,
        time
      );

      float noise1 = fbm(noisePos) * uIntensity;
      float noise2 = fbm(noisePos * 2.0 + vec3(100.0, 100.0, time * 0.5)) * uIntensity;
      float noise3 = fbm(noisePos * 0.5 + vec3(50.0, 50.0, time * 0.3)) * uIntensity;

      vec2 distortion = vec2(
        fbm(vec3(p * 2.0 + time * 0.2, time)),
        fbm(vec3(p * 2.0 - time * 0.2, time + 100.0))
      ) * 0.1 * uIntensity;

      vec2 distortedP = p + distortion;
      float dist = length(distortedP);
      float vignette = 1.0 - smoothstep(0.5, 1.5, dist);

      // Create the 3D sculptured gradient colors
      vec3 finalColor = mix(uColor1, uColor2, smoothstep(-0.5, 0.5, noise1));
      finalColor = mix(finalColor, uColor3, smoothstep(-0.3, 0.7, noise2));

      float glow = smoothstep(1.0, 0.0, dist) * 0.3;
      finalColor += glow * vec3(0.2, 0.1, 0.4);
      finalColor *= vignette;
      finalColor += (noise1 * 0.1 + 0.05);

      // FLASHLIGHT/SPOTLIGHT EFFECT around cursor (immersive-g.com style)
      // Use pixel coordinates for both to avoid coordinate system mismatch
      vec2 fragPx = gl_FragCoord.xy;
      vec2 mousePx = uMouse * uResolution;

      // Normalize distance by screen diagonal for consistent radius across resolutions
      float screenDiagonal = length(uResolution);
      float distToMouse = length(fragPx - mousePx) / screenDiagonal;

      // Very tight, dramatic spotlight - almost complete darkness outside
      float spotlightRadius = 0.15; // Adjusted for diagonal-normalized distance
      float spotlight = 1.0 - smoothstep(0.0, spotlightRadius, distToMouse);
      spotlight = pow(spotlight, 4.0); // Very sharp falloff for dramatic effect

      // Almost complete darkness - only 1% ambient light for dramatic effect
      float baseBrightness = 0.01;

      // Very bright reveal in spotlight (3x brightness)
      float brightness = mix(baseBrightness, 3.0, spotlight);

      finalColor *= brightness;

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  useEffect(() => {
    if (!canvasRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      alpha: true,
    });

    const updateSize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      if (uniformsRef.current) {
        uniformsRef.current.uResolution.value.set(window.innerWidth, window.innerHeight);
      }
    };

    updateSize();

    // Brand colors (converted to 0-1 range)
    const uniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uSpeed: { value: speed },
      uIntensity: { value: 1.0 },
      uColor1: { value: new THREE.Vector3(0.04, 0.15, 0.25) }, // Deep blue #0a2540
      uColor2: { value: new THREE.Vector3(0.39, 0.36, 1.0) },  // Purple #635bff
      uColor3: { value: new THREE.Vector3(0.0, 0.83, 1.0) },   // Cyan #00d4ff
      uMouseInfluence: { value: 0.5 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    sceneRef.current = scene;
    rendererRef.current = renderer;
    uniformsRef.current = uniforms;

    // Mouse move handler with static offset correction
    const handleMouseMove = (e: MouseEvent) => {
      // Apply static offset to match canvas coordinates
      const offsetX = 0;
      const offsetY = 0;
      mouseRef.current.target.x = (e.clientX + offsetX) / window.innerWidth;
      mouseRef.current.target.y = 1.0 - (e.clientY + offsetY) / window.innerHeight;
    };

    // Animation loop
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);

      // Smooth mouse movement
      mouseRef.current.current.x += (mouseRef.current.target.x - mouseRef.current.current.x) * 0.05;
      mouseRef.current.current.y += (mouseRef.current.target.y - mouseRef.current.current.y) * 0.05;

      uniforms.uTime.value += 0.01;
      uniforms.uMouse.value = mouseRef.current.current;

      renderer.render(scene, camera);
    };

    animate();

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('resize', updateSize);

    // Cleanup
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', updateSize);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [speed]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: -1,
      }}
    />
  );
}
