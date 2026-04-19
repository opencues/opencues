/**
 * TTS adapter using the Web Speech API.
 * Replaces spawn('speak.sh') / spawn('SpeakCtl.exe').
 */
export class WebSpeechAdapter {
  private utterance: SpeechSynthesisUtterance | null = null;

  speak(text: string, rate: number = 2): void {
    this.cancel();
    this.utterance = new SpeechSynthesisUtterance(text);
    this.utterance.rate = Math.max(0.5, Math.min(rate, 5));
    speechSynthesis.speak(this.utterance);
  }

  cancel(): void {
    speechSynthesis.cancel();
    this.utterance = null;
  }

  get speaking(): boolean {
    return speechSynthesis.speaking;
  }
}
