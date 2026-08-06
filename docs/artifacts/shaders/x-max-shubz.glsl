// Vendored UNMODIFIED from ShaderShop: shaders/x-max-shubz-hardcoded.glsl
// "hardcoded" = every parameter is baked in, so it needs only the standard
// ShaderToy uniforms (iResolution, iTime, iChannel0). Re-sync by re-copying.
// X-max Shubz Hardcoded - All parameters baked in from default configuration
#ifdef GL_ES
precision mediump float;
#endif

// === HARDCODED PARAMETERS (from default configuration) ===
const float baseFrequency = 0.07;
const int octaves = 2;
const float scale = 0.5;
const float positionAdjuster = 0.4;
const float perlinAdjustment = -0.80;
const float noiseScale = 320.0;
const bool animateNoise = true;
const float animationSpeed = 6.0;
const bool hasImage = true;
const int gradientDirection = 0;
const bool showIsolines1 = true;
const float isolineColor1R = 0.99;
const float isolineColor1G = 0.11;
const float isolineColor1B = 0.0;
const float isolineOpacity1 = 1.0;
const float blurRadius1 = 42.20;
const float blurIntensity1 = 0.70;
const int strokeDirection1 = 1;
const bool showIsolines2 = true;
const float isolineColor2R = 1.0;
const float isolineColor2G = 1.0;
const float isolineColor2B = 0.0;
const float isolineOpacity2 = 1.0;
const float blurRadius2 = 100.0;
const float blurIntensity2 = 0.80;
const int strokeDirection2 = 2;
const bool showIsolines3 = true;
const float isolineColor3R = 0.62;
const float isolineColor3G = 0.0;
const float isolineColor3B = 0.0;
const float isolineOpacity3 = 1.0;
const float blurRadius3 = 100.0;
const float blurIntensity3 = 3.0;
const int strokeDirection3 = 2;
const bool showIsolines4 = true;
const float isolineColor4R = 1.0;
const float isolineColor4G = 1.0;
const float isolineColor4B = 1.0;
const float isolineOpacity4 = 1.0;
const float blurRadius4 = 3.8;
const float blurIntensity4 = 1.40;
const int strokeDirection4 = 0;
const bool showIsolines5 = true;
const float isolineColor5R = 1.0;
const float isolineColor5G = 0.49;
const float isolineColor5B = 0.57;
const float isolineOpacity5 = 1.0;
const float blurRadius5 = 45.20;
const float blurIntensity5 = 3.0;
const int strokeDirection5 = 0;
const bool showIsolines6 = true;
const float isolineColor6R = 0.0;
const float isolineColor6G = 0.0;
const float isolineColor6B = 0.0;
const float isolineOpacity6 = 1.0;
const float blurRadius6 = 5.60;
const float blurIntensity6 = 3.0;
const int strokeDirection6 = 2;
const bool silhouetteMask = true;

// === ORIGINAL SHADER CODE (unchanged) ===
vec2 random2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float fade(float t) { return t * t * (3.0 - 2.0 * t); }
vec2 fastNormalize(vec2 v) { return v / (abs(v.x) + abs(v.y) + 0.0001); }

float perlin_noise(vec2 st) {
    vec2 i = floor(st), f = fract(st);
    float u = fade(f.x), v = fade(f.y);
    vec2 r00 = 2.0 * random2(i) - 1.0, r10 = 2.0 * random2(i + vec2(1.0, 0.0)) - 1.0;
    vec2 r01 = 2.0 * random2(i + vec2(0.0, 1.0)) - 1.0, r11 = 2.0 * random2(i + vec2(1.0, 1.0)) - 1.0;
    return (mix(mix(dot(r00, f), dot(r10, f - vec2(1.0, 0.0)), u), 
                mix(dot(r01, f - vec2(0.0, 1.0)), dot(r11, f - vec2(1.0, 1.0)), u), v) + 1.0) * 0.5;
}

// Static FBM variants - compile-time optimized for massive speedup
float fbm1(vec2 st) {
    return 0.5 * perlin_noise(st * baseFrequency);
}

float fbm2(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0;
    value += 0.25 * perlin_noise(st * freq);
    return value;
}

float fbm3(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    return value;
}

float fbm4(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0625 * perlin_noise(st * freq);
    return value;
}

float fbm5(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.03125 * perlin_noise(st * freq);
    return value;
}

float fbm6(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.03125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.015625 * perlin_noise(st * freq);
    return value;
}

float fbm8(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.03125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.015625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0078125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.00390625 * perlin_noise(st * freq);
    return value;
}

float fbm10(vec2 st) {
    float freq = baseFrequency;
    float value = 0.5 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.25 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.03125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.015625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0078125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.00390625 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.001953125 * perlin_noise(st * freq);
    freq *= 2.0; value += 0.0009765625 * perlin_noise(st * freq);
    return value;
}

// Optimized FBM dispatcher - chooses compile-time optimized variant
float fbm(vec2 st) {
    if (octaves == 1) return fbm1(st);
    else if (octaves == 2) return fbm2(st);
    else if (octaves == 3) return fbm3(st);
    else if (octaves == 4) return fbm4(st);
    else if (octaves == 5) return fbm5(st);
    else if (octaves == 6) return fbm6(st);
    else if (octaves <= 8) return fbm8(st);
    else return fbm10(st); // 9-10 octaves
}


const vec3 LUM = vec3(0.299, 0.587, 0.114);
float lum(vec3 c) { return dot(c, LUM); }

// Raw luminance stroke processing (for isoline 1) - optimized version
float strokeRaw(vec2 gradDir, float blurOffset, vec2 displacedUv, float centerLum, float intensity, int strokeDir) {
    if (strokeDir == 0) return 1.0;
    float strokeIntensity = 0.0;
    
    if (strokeDir == 1) { // Inward strokes - reduced to 3 samples
        for (int i = 1; i <= 3; i++) {
            float dist = float(i) * 0.3;
            float sampleLum = lum(texture2D(iChannel0, displacedUv - gradDir * blurOffset * dist).rgb) * intensity;
            strokeIntensity += smoothstep(0.0, 0.1, centerLum - sampleLum) * (1.0 - dist * 0.3);
        }
    } else { // Outward strokes - reduced to 3 samples
        for (int i = 1; i <= 3; i++) {
            float dist = float(i) * 0.3;
            float sampleLum = lum(texture2D(iChannel0, displacedUv + gradDir * blurOffset * dist).rgb) * intensity;
            strokeIntensity += smoothstep(0.0, 0.15, sampleLum - centerLum) * (1.0 - dist * 0.3);
        }
    }
    return clamp(strokeIntensity * 0.8, 0.0, 1.0);
}

// Black/white stroke processing (for isolines 2,3,4) - optimized version
float strokeBW(vec2 gradDir, float blurOffset, vec2 displacedUv, float centerBw, int strokeDir) {
    if (strokeDir == 0) return 1.0;
    float strokeIntensity = 0.0;
    
    if (strokeDir == 1) { // Inward strokes - reduced to 3 samples
        for (int i = 1; i <= 3; i++) {
            float dist = float(i) * 0.3;
            float sampleBw = step(0.5, lum(texture2D(iChannel0, displacedUv - gradDir * blurOffset * dist).rgb));
            strokeIntensity += smoothstep(0.0, 0.1, centerBw - sampleBw) * (1.0 - dist * 0.3);
        }
    } else { // Outward strokes - reduced to 3 samples
        for (int i = 1; i <= 3; i++) {
            float dist = float(i) * 0.3;
            float sampleBw = step(0.5, lum(texture2D(iChannel0, displacedUv + gradDir * blurOffset * dist).rgb));
            strokeIntensity += smoothstep(0.0, 0.15, sampleBw - centerBw) * (1.0 - dist * 0.3);
        }
    }
    return clamp(strokeIntensity * 0.8, 0.0, 1.0);
}

// Calculate gradient based on direction mode - includes forward difference for directional effects
vec2 calculateGradient(vec4 samples, int direction, float centerLum) {
    // samples: x=left, y=right, z=up, w=down
    // Modes 0-6: Centered difference (symmetric edge detection)
    if (direction == 0) { // All directions (standard centered difference)
        return vec2(samples.y - samples.x, samples.z - samples.w);
    } else if (direction == 1) { // Horizontal (Left+Right)
        return vec2(samples.y - samples.x, 0.0);
    } else if (direction == 2) { // Vertical (Up+Down)
        return vec2(0.0, samples.z - samples.w);
    } else if (direction == 3) { // Diag-NW (centered)
        return vec2(samples.x - samples.y*0.5 - samples.z*0.5, samples.z - samples.x*0.5 - samples.y*0.5);
    } else if (direction == 4) { // Diag-NE (centered)
        return vec2(samples.y - samples.x*0.5 - samples.z*0.5, samples.z - samples.y*0.5 - samples.x*0.5);
    } else if (direction == 5) { // Diag-SE (centered)
        return vec2(samples.y - samples.x*0.5 - samples.w*0.5, samples.w - samples.y*0.5 - samples.x*0.5);
    } else if (direction == 6) { // Diag-SW (centered)
        return vec2(samples.x - samples.y*0.5 - samples.w*0.5, samples.w - samples.x*0.5 - samples.y*0.5);
    }
    // Default fallback
    return vec2(samples.y - samples.x, samples.z - samples.w);
}


// Cached version of isoline 1 calculation
float calculateEdgeIsolines1Cached(vec2 displacedUv, float radius, float intensity, int strokeDir, vec4 lumSamples, float centerLum) {
    if (!hasImage || intensity < 0.01 || radius < 0.1) return 0.0;
    float blurOffset = radius / iResolution.x;
    vec4 samples = lumSamples * intensity;
    float centerLumScaled = centerLum * intensity;
    vec2 grad = calculateGradient(samples, gradientDirection, centerLum);
    float gx = grad.x, gy = grad.y;
    float contentMask = smoothstep(0.05, 0.15, centerLum);
    return step(0.1, abs(gx) + abs(gy)) * contentMask * strokeRaw(fastNormalize(vec2(gx, gy)), blurOffset, displacedUv, centerLumScaled, intensity, strokeDir);
}

// Isoline 1: Works on original image - optimized sampling based on gradient direction
float calculateEdgeIsolines1(vec2 uv, vec2 displacement, float radius, float intensity, int strokeDir) {
    if (!hasImage || intensity < 0.01 || radius < 0.1) return 0.0;
    vec2 displacedUv = uv + displacement;
    float blurOffset = radius / iResolution.x;
    
    vec4 samples;
    if (gradientDirection == 1) { // Horizontal - need left/right
        samples = vec4(
            lum(texture2D(iChannel0, displacedUv + vec2(-blurOffset, 0.0)).rgb),
            lum(texture2D(iChannel0, displacedUv + vec2(blurOffset, 0.0)).rgb),
            0.0, 0.0
        );
    } else if (gradientDirection == 2) { // Vertical - need up/down
        samples = vec4(
            0.0, 0.0,
            lum(texture2D(iChannel0, displacedUv + vec2(0.0, blurOffset)).rgb),
            lum(texture2D(iChannel0, displacedUv + vec2(0.0, -blurOffset)).rgb)
        );
    } else { // All directions or centered diagonals need all 4 samples
        samples = vec4(
            lum(texture2D(iChannel0, displacedUv + vec2(-blurOffset, 0.0)).rgb),
            lum(texture2D(iChannel0, displacedUv + vec2(blurOffset, 0.0)).rgb),
            lum(texture2D(iChannel0, displacedUv + vec2(0.0, blurOffset)).rgb),
            lum(texture2D(iChannel0, displacedUv + vec2(0.0, -blurOffset)).rgb)
        );
    }
    
    float centerLum = lum(texture2D(iChannel0, displacedUv).rgb);
    return calculateEdgeIsolines1Cached(displacedUv, radius, intensity, strokeDir, samples, centerLum);
}

// Isoline 2: Cascades from isoline 1
float calculateEdgeIsolines2(vec2 uv, vec2 displacement, float radius, float intensity, int strokeDir) {
    if (!hasImage || intensity < 0.01 || radius < 0.1) return 0.0;
    vec2 displacedUv = uv + displacement;
    float blurOffset = radius / iResolution.x;
    vec4 offsets = vec4(-blurOffset, blurOffset, 0.0, 0.0);
    vec4 bwSamples = step(vec4(0.5), vec4(
        lum(texture2D(iChannel0, displacedUv + vec2(offsets.x, 0.0)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(offsets.y, 0.0)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(0.0, offsets.y)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(0.0, offsets.x)).rgb)
    ));
    float centerBw = step(0.5, lum(texture2D(iChannel0, displacedUv).rgb));
    if (blurIntensity1 > 0.01) {
        float iso1Lum = lum(vec3(isolineColor1R, isolineColor1G, isolineColor1B));
        float edge1C = calculateEdgeIsolines1(uv, displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1L = calculateEdgeIsolines1(uv + vec2(offsets.x, 0.0), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1R = calculateEdgeIsolines1(uv + vec2(offsets.y, 0.0), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1U = calculateEdgeIsolines1(uv + vec2(0.0, offsets.y), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1D = calculateEdgeIsolines1(uv + vec2(0.0, offsets.x), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        bwSamples = step(vec4(0.95), mix(bwSamples, vec4(iso1Lum), vec4(edge1L, edge1R, edge1U, edge1D) * isolineOpacity1));
        centerBw = step(0.95, mix(centerBw, iso1Lum, edge1C * isolineOpacity1));
    }
    vec2 grad = calculateGradient(bwSamples, gradientDirection, centerBw);
    float gx = grad.x * intensity, gy = grad.y * intensity;
    float contentMask = smoothstep(0.05, 0.15, lum(texture2D(iChannel0, displacedUv).rgb));
    return step(0.1, abs(gx) + abs(gy)) * contentMask * strokeBW(fastNormalize(vec2(gx, gy)), blurOffset, displacedUv, centerBw, strokeDir);
}

// Isoline 3: Cascades from isolines 1 and 2  
float calculateEdgeIsolines3(vec2 uv, vec2 displacement, float radius, float intensity, int strokeDir) {
    if (!hasImage || intensity < 0.01 || radius < 0.1) return 0.0;
    vec2 displacedUv = uv + displacement;
    float blurOffset = radius / iResolution.x;
    vec4 offsets = vec4(-blurOffset, blurOffset, 0.0, 0.0);
    vec4 bwSamples = step(vec4(0.5), vec4(
        lum(texture2D(iChannel0, displacedUv + vec2(offsets.x, 0.0)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(offsets.y, 0.0)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(0.0, offsets.y)).rgb),
        lum(texture2D(iChannel0, displacedUv + vec2(0.0, offsets.x)).rgb)
    ));
    float centerBw = step(0.5, lum(texture2D(iChannel0, displacedUv).rgb));
    // Apply isoline 1
    if (blurIntensity1 > 0.01) {
        float iso1Lum = lum(vec3(isolineColor1R, isolineColor1G, isolineColor1B));
        float edge1C = calculateEdgeIsolines1(uv, displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1L = calculateEdgeIsolines1(uv + vec2(offsets.x, 0.0), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1R = calculateEdgeIsolines1(uv + vec2(offsets.y, 0.0), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1U = calculateEdgeIsolines1(uv + vec2(0.0, offsets.y), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        float edge1D = calculateEdgeIsolines1(uv + vec2(0.0, offsets.x), displacement, blurRadius1, blurIntensity1, strokeDirection1);
        bwSamples = step(vec4(0.95), mix(bwSamples, vec4(iso1Lum), vec4(edge1L, edge1R, edge1U, edge1D) * isolineOpacity1));
        centerBw = step(0.95, mix(centerBw, iso1Lum, edge1C * isolineOpacity1));
    }
    // Apply isoline 2  
    if (blurIntensity2 > 0.01) {
        float iso2Lum = lum(vec3(isolineColor2R, isolineColor2G, isolineColor2B));
        float edge2C = calculateEdgeIsolines2(uv, displacement, blurRadius2, blurIntensity2, strokeDirection2);
        float edge2L = calculateEdgeIsolines2(uv + vec2(offsets.x, 0.0), displacement, blurRadius2, blurIntensity2, strokeDirection2);
        float edge2R = calculateEdgeIsolines2(uv + vec2(offsets.y, 0.0), displacement, blurRadius2, blurIntensity2, strokeDirection2);
        float edge2U = calculateEdgeIsolines2(uv + vec2(0.0, offsets.y), displacement, blurRadius2, blurIntensity2, strokeDirection2);
        float edge2D = calculateEdgeIsolines2(uv + vec2(0.0, offsets.x), displacement, blurRadius2, blurIntensity2, strokeDirection2);
        bwSamples = step(vec4(0.95), mix(bwSamples, vec4(iso2Lum), vec4(edge2L, edge2R, edge2U, edge2D) * isolineOpacity2));
        centerBw = step(0.95, mix(centerBw, iso2Lum, edge2C * isolineOpacity2));
    }
    vec2 grad = calculateGradient(bwSamples, gradientDirection, centerBw);
    float gx = grad.x * intensity, gy = grad.y * intensity;
    float contentMask = smoothstep(0.05, 0.15, lum(texture2D(iChannel0, displacedUv).rgb));
    return step(0.1, abs(gx) + abs(gy)) * contentMask * strokeBW(fastNormalize(vec2(gx, gy)), blurOffset, displacedUv, centerBw, strokeDir);
}


void mainImage(out vec4 fragColor, vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float aspectRatio = iResolution.x / iResolution.y;
    uv = aspectRatio > 1.0 ? vec2((uv.x - 0.5) * aspectRatio + 0.5, uv.y) : vec2(uv.x, (uv.y - 0.5) / aspectRatio + 0.5);
    
    // Silhouette mask mode - skip expensive operations for low-saturation pixels
    if (silhouetteMask && hasImage) {
        vec3 baseColor = texture2D(iChannel0, uv).rgb;
        float maxVal = max(max(baseColor.r, baseColor.g), baseColor.b);
        float minVal = min(min(baseColor.r, baseColor.g), baseColor.b);
        float saturation = (maxVal > 0.0) ? (maxVal - minVal) / maxVal : 0.0;
        
        // Early exit if pixel will be mostly transparent (smoothstep(0.0, 0.4, saturation) < 0.05)
        if (saturation < 0.02) {
            fragColor = vec4(0.0, 0.0, 0.0, 0.0);
            return;
        }
    }
    
    // Calculate displacement
    vec2 displacement = vec2(0.0);
    if (scale > 0.001) {
        vec2 noiseCoord = uv * noiseScale + perlinAdjustment + (animateNoise ? iTime * animationSpeed : 0.0);
        vec2 noise = vec2(fbm(noiseCoord + vec2(5.2, 1.3)), fbm(noiseCoord + vec2(1.7, 9.2)));
        displacement = (noise - positionAdjuster) * scale;
    }
    
    // Calculate isolines with optimized texture caching
    vec4 isolineIntensities = vec4(0.0);
    float isolineIntensity5 = 0.0;
    float isolineIntensity6 = 0.0;
    
    vec2 displacedUv = uv + displacement;
    
    // HARD-BAKED OPTIMIZATION: Early exit based on displaced pixel saturation (non-optional performance boost)
    if (hasImage) {
        vec3 displacedColor = texture2D(iChannel0, displacedUv).rgb;
        float maxVal = max(max(displacedColor.r, displacedColor.g), displacedColor.b);
        float minVal = min(min(displacedColor.r, displacedColor.g), displacedColor.b);
        float saturation = (maxVal > 0.0) ? (maxVal - minVal) / maxVal : 0.0;
        
        // Hard exit for extremely low saturation displaced pixels (avoids all isoline computation)
        if (saturation < 0.015) {
            fragColor = vec4(0.0, 0.0, 0.0, 0.0);
            return;
        }
    }
    
    // Cache texture samples for isolines that share the same blur radius
    vec4 cachedSamples1 = vec4(0.0);
    float cachedCenter1 = 0.0;
    bool cached1 = false;
    
    // Isoline 1 - optimized sampling based on gradient direction
    if (showIsolines1 && isolineOpacity1 > 0.01) {
        float blurOffset = blurRadius1 / iResolution.x;
        
        if (gradientDirection == 1) { // Horizontal
            cachedSamples1 = vec4(
                lum(texture2D(iChannel0, displacedUv + vec2(-blurOffset, 0.0)).rgb),
                lum(texture2D(iChannel0, displacedUv + vec2(blurOffset, 0.0)).rgb),
                0.0, 0.0
            );
        } else if (gradientDirection == 2) { // Vertical
            cachedSamples1 = vec4(
                0.0, 0.0,
                lum(texture2D(iChannel0, displacedUv + vec2(0.0, blurOffset)).rgb),
                lum(texture2D(iChannel0, displacedUv + vec2(0.0, -blurOffset)).rgb)
            );
        } else { // All directions or diagonals
            cachedSamples1 = vec4(
                lum(texture2D(iChannel0, displacedUv + vec2(-blurOffset, 0.0)).rgb),
                lum(texture2D(iChannel0, displacedUv + vec2(blurOffset, 0.0)).rgb),
                lum(texture2D(iChannel0, displacedUv + vec2(0.0, blurOffset)).rgb),
                lum(texture2D(iChannel0, displacedUv + vec2(0.0, -blurOffset)).rgb)
            );
        }
        
        cachedCenter1 = lum(texture2D(iChannel0, displacedUv).rgb);
        cached1 = true;
        isolineIntensities.x = calculateEdgeIsolines1Cached(displacedUv, blurRadius1, blurIntensity1, strokeDirection1, cachedSamples1, cachedCenter1);
    }
    
    // Other isolines
    if (showIsolines2 && isolineOpacity2 > 0.01) 
        isolineIntensities.y = calculateEdgeIsolines2(uv, displacement, blurRadius2, blurIntensity2, strokeDirection2);
    if (showIsolines3 && isolineOpacity3 > 0.01) 
        isolineIntensities.z = calculateEdgeIsolines3(uv, displacement, blurRadius3, blurIntensity3, strokeDirection3);
    if (showIsolines4 && isolineOpacity4 > 0.01) 
        isolineIntensities.w = calculateEdgeIsolines2(uv, displacement, blurRadius4, blurIntensity4, strokeDirection4);
    
    // Isoline 5 - reuse cache if same radius as isoline 1
    if (showIsolines5 && isolineOpacity5 > 0.01) {
        if (cached1 && abs(blurRadius5 - blurRadius1) < 0.001) {
            isolineIntensity5 = calculateEdgeIsolines1Cached(displacedUv, blurRadius5, blurIntensity5, strokeDirection5, cachedSamples1, cachedCenter1);
        } else {
            isolineIntensity5 = calculateEdgeIsolines1(uv, displacement, blurRadius5, blurIntensity5, strokeDirection5);
        }
    }
    
    if (showIsolines6 && isolineOpacity6 > 0.01) 
        isolineIntensity6 = calculateEdgeIsolines3(uv, displacement, blurRadius6, blurIntensity6, strokeDirection6);
    
    // Apply to image or visualization  
    if (hasImage) {
        vec4 imageColor = texture2D(iChannel0, uv + displacement);
        fragColor = vec4(imageColor.rgb, imageColor.a);
    } else {
        vec2 normalizedDisp = displacement / scale * 0.5 + 0.5;
        fragColor = vec4(vec3(normalizedDisp, length(displacement) / scale) * (sin(uv.x * 10.0) * sin(uv.y * 10.0) * 0.1 + 0.9), 1.0);
    }
    
    // Make low-saturation pixels transparent (only when not in silhouette mask mode)
    if (!silhouetteMask) {
        vec3 c = fragColor.rgb;
        float maxVal = max(max(c.r, c.g), c.b);
        float minVal = min(min(c.r, c.g), c.b);
        float saturation = (maxVal > 0.0) ? (maxVal - minVal) / maxVal : 0.0;
        fragColor.a = smoothstep(0.0, 0.4, saturation);
    }
    
    // Apply isolines in sequence: 1 → 3 → 6 → 4 → 2 → 5
    // Blur: If enabled, render a softer version underneath each isoline
    
    if (showIsolines1 && isolineIntensities.x > 0.01 && isolineOpacity1 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor1R, isolineColor1G, isolineColor1B), isolineIntensities.x * isolineOpacity1);
    
    if (showIsolines3 && isolineIntensities.z > 0.01 && isolineOpacity3 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor3R, isolineColor3G, isolineColor3B), isolineIntensities.z * isolineOpacity3);
    
    if (showIsolines6 && isolineIntensity6 > 0.01 && isolineOpacity6 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor6R, isolineColor6G, isolineColor6B), isolineIntensity6 * isolineOpacity6);
    
    if (showIsolines4 && isolineIntensities.w > 0.01 && isolineOpacity4 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor4R, isolineColor4G, isolineColor4B), isolineIntensities.w * isolineOpacity4);
    
    if (showIsolines2 && isolineIntensities.y > 0.01 && isolineOpacity2 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor2R, isolineColor2G, isolineColor2B), isolineIntensities.y * isolineOpacity2);
    
    if (showIsolines5 && isolineIntensity5 > 0.01 && isolineOpacity5 > 0.01)
        fragColor.rgb = mix(fragColor.rgb, vec3(isolineColor5R, isolineColor5G, isolineColor5B), isolineIntensity5 * isolineOpacity5);
}