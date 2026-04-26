using System;
using System.Speech.Synthesis;

class SpeakCtl {
    static void Main(string[] args) {
        if (args.Length < 1) return;
        int rate = 2;
        if (args.Length > 1) int.TryParse(args[1], out rate);
        var synth = new SpeechSynthesizer();
        synth.Rate = Math.Max(-10, Math.Min(10, rate));
        synth.Speak(args[0]);
    }
}
