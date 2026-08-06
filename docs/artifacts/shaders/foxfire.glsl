// Foxfire Effect - Translated from AGSL to WGSL
// Original: watchFoxFireShaders.kt

// Constant value for 2 * PI, used for sine wave calculations
const float TWO_PI = 6.28318530718;
// Maximum value for hue, representing the hue range in degrees
const float HUE_MAX = 360.0;

// Function to calculate hue, saturation, and value based on an RGB color
vec3 calculateHueSaturationValue(vec3 color) {
    // Extract the red channel from the input color
    float r = color.r;
    // Extract the green channel from the input color
    float g = color.g;
    // Extract the blue channel from the input color
    float b = color.b;

    // Find the maximum and minimum values among the RGB channels
    float maxVal = max(max(r, g), b);
    float minVal = min(min(r, g), b);
    // Calculate the difference between the max and min values
    float delta = maxVal - minVal;

    // Initialize the hue variable
    float hue = 0.0;
    // If there's a difference between the channels, calculate hue based on the dominant channel
    if (delta > 0.0) {
        // Calculate hue when red is dominant
        if (maxVal == r) {
            hue = (g - b) / delta;
        // Calculate hue when green is dominant
        } else if (maxVal == g) {
            hue = 2.0 + (b - r) / delta;
        // Calculate hue when blue is dominant
        } else {
            hue = 4.0 + (r - g) / delta;
        }
        // Convert hue to degrees
        hue *= 60.0;
        // Ensure the hue value is positive by adding 360 degrees
        if (hue < 0.0) hue += HUE_MAX;
    }

    // Calculate saturation as the ratio of delta to the maximum RGB value
    float saturation = (maxVal > 0.0) ? (delta / maxVal) : 0.0;
    // In the HSV model, the value is simply the maximum RGB component
    float value = maxVal;

    // Return both hue and saturation as a vec3
    return vec3(hue, saturation, value);
}

// Map Hue Groups
float mapHueGroups(float hueGroup) {
    // Result
    float result;

    // Convert Hue Group to Int
    int hueGroupInt = int(hueGroup);

    // Switch
    if (hueGroupInt == 0) {
        // Hue Red
        result = hue_red;
    } else if (hueGroupInt == 1) {
        // Hue Red Orange
        result = hue_red_orange;
    } else if (hueGroupInt == 2) {
        // Hue Orange
        result = hue_orange;
    } else if (hueGroupInt == 3) {
        // Hue Yellow
        result = hue_yellow;
    } else if (hueGroupInt == 4) {
        // Hue Yellow Green
        result = hue_yellow_green;
    } else if (hueGroupInt == 5) {
        // Hue Green
        result = hue_green;
    } else if (hueGroupInt == 6) {
        // Hue Cyan
        result = hue_cyan;
    } else if (hueGroupInt == 7) {
        // Hue Blue
        result = hue_blue;
    } else if (hueGroupInt == 8) {
        // Hue Blue Purple
        result = hue_blue_purple;
    } else if (hueGroupInt == 9) {
        // Hue Purple
        result = hue_purple;
    } else if (hueGroupInt == 10) {
        // Hue Magenta
        result = hue_magenta;
    } else if (hueGroupInt == 11) {
        // Hue Red Purple
        result = hue_red_purple;
    } else {
        // Default
        result = hue_red;
    }
    return result;
}

void mainImage(out vec4 fragColor, vec2 fragCoord) {
    // Normalize coordinates to 0-1 range
    vec2 uv = fragCoord / iResolution.xy;

    // Retrieve the original pixel color from the input texture
    vec4 originalColor = texture2D(iChannel0, uv);

    // Use TurboEngine-style animationValue (ping-pongs between animationLowerBound and animationUpperBound)
    // Add progression offset for phase control
    float animatedProgression = animationValue + progression;

    // Calculate the Hue, Saturation and Value for the Current Pixel's Color
    vec3 hueSatValue = calculateHueSaturationValue(originalColor.rgb);
    // Extract the hue from the result
    float rawHue = hueSatValue.x;
    // Adjust Hue to be centered around 0 Degrees
    float hue = mod(rawHue - 15.0 + 360.0, 360.0);
    // Extract the saturation from the result
    float saturation = hueSatValue.y;
    // Extract the value from the result
    float value = hueSatValue.z;

    // Apply the blackening effect only if the saturation exceeds the defined threshold
    if (saturation >= saturationThreshold && value != 0.0) {
        // Group the hue into discrete sections based on hueGroupDelta (e.g., groups of 12 degrees)
        float unmappedHueGroup = floor(hue / 12.0);

        // Map Hue Groups
        float hueGroup = mapHueGroups(unmappedHueGroup);

        // If Valid Hue Group
        if (hueGroup > -1.0) {
            // Further split each hue group into subgroups (quarter the hueGroupDelta)
            float hueSubGroup = floor(hue / (hueGroupDelta / 4.0));

            // Calculate the blackening factor based on progression and hue group
            float groupProgression = animatedProgression + hueGroup * groupPhaseOffset;
            // Calculate opacity factor using sine wave (clamp output, not input)
            float opacityFactor = clamp(sin(groupProgression * TWO_PI) * 0.5 + 0.5, 0.0, 1.0);

            // Compute a pseudo-random value based on hue
            float randomOffset = fract(sin(hue * 12.9898) * 43758.5453);
            // Add the random offset scaled by a small factor to control variance
            float subGroupProgression = animatedProgression + hueSubGroup * groupPhaseOffset + randomOffset * 0.2;

            // Calculate saturation adjustment factor using sine wave - Group Progression
            float saturationFactor = clamp(sin(groupProgression * TWO_PI) * 0.5 + 0.5, 0.0, 1.0);

            // If Stepped Progression
            if (steppedProgression > 0.5) {
                // Calculate saturation adjustment factor using sine wave - Group Progression
                saturationFactor = clamp(sin(subGroupProgression * TWO_PI) * 0.5 + 0.5, 0.0, 1.0);
                // If SubGroupProgression
                if (subGroupProgression > 0.5) {
                    // Calculate saturation adjustment factor using sine wave - Sub Group Progression
                    saturationFactor = clamp(sin(subGroupProgression * TWO_PI) * 0.5 + 0.5, 0.0, 1.0);
                }
            }

            // Return the modified color with adjusted opacity (clamped to prevent blow-out)
            float finalAlpha = clamp(opacityFactor * saturationFactor, 0.0, 1.0);
            fragColor = vec4(originalColor.rgb, finalAlpha);
            return;
        }
    }

    // If the saturation is below the threshold, apply a stronger blackening factor
    vec3 blackenedOriginalColor = mix(originalColor.rgb, vec3(0.0, 0.0, 0.0), 0.0);

    // Return the blackened color with zero opacity
    fragColor = vec4(blackenedOriginalColor, 0.0);
}
