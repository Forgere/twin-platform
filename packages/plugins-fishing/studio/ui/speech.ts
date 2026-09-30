import { createSignal, onCleanup } from 'solid-js';

/**
 * 语音输入（浏览器 Web Speech API）。
 *
 * 情况复杂、点选说不清时才用它："钓了半小时，漂老是往上顶一下又回去"。
 * 识别只负责把话变成字；归类是 plugins-fishing 的 `matchSituation()`。
 *
 * Chrome / Edge 提供 `webkitSpeechRecognition`，Firefox 没有——不支持时
 * `supported` 为 false，UI 退回到文字输入，功能不缺。
 */

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  'not-allowed': '没有麦克风权限——在地址栏允许麦克风后再试。',
  'no-speech': '没听到声音，再说一次？',
  network: '语音识别需要联网。',
  'audio-capture': '找不到麦克风。',
};

export interface Speech {
  readonly supported: boolean;
  listening(): boolean;
  /** 正在识别中的文字（含未定稿部分）。 */
  interim(): string;
  error(): string | undefined;
  /** 开始听；一句话说完（定稿）时回调。 */
  start(onFinal: (text: string) => void): void;
  stop(): void;
}

export function createSpeech(lang = 'zh-CN'): Speech {
  const Ctor = recognitionCtor();
  const [listening, setListening] = createSignal(false);
  const [interim, setInterim] = createSignal('');
  const [error, setError] = createSignal<string>();
  let active: Recognition | undefined;

  const stop = (): void => {
    active?.stop();
  };

  const start = (onFinal: (text: string) => void): void => {
    if (!Ctor) return;
    active?.abort();
    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (event) => {
      let text = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) finalText += result[0].transcript;
        else text += result[0].transcript;
      }
      setInterim(finalText + text);
    };
    recognition.onerror = (event) => setError(ERROR_TEXT[event.error] ?? '语音识别出错：' + event.error);
    recognition.onend = () => {
      setListening(false);
      active = undefined;
      if (finalText.trim() !== '') onFinal(finalText.trim());
    };
    setError(undefined);
    setInterim('');
    setListening(true);
    active = recognition;
    try {
      recognition.start();
    } catch (caught) {
      setListening(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  onCleanup(() => active?.abort());

  return { supported: Ctor !== undefined, listening, interim, error, start, stop };
}
