interface ScreenshotCapture {
  dataUrl?: string;
  base64?: string;
  contentType?: string;
  error?: string;
}

class TvCameraController {
  private stream: MediaStream | null = null;
  private videoElement?: HTMLVideoElement;
  private canvasElement?: HTMLCanvasElement;
  private initPromise?: Promise<void>;

  private isBrowser(): boolean {
    return typeof window !== "undefined" && typeof document !== "undefined";
  }

  private async startCamera(): Promise<void> {
    if (!this.isBrowser()) {
      throw new Error("Camera is only available in a browser environment.");
    }

    if (this.stream) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }

    console.info("[TV Agentic Flow] Requesting access to the local camera...");

    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "environment",
      },
      audio: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.position = "fixed";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.style.width = "0";
    video.style.height = "0";

    video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
        resolve();
      };
      const onError = (event: Event) => {
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
        reject(
          event instanceof Error
            ? event
            : new Error("Failed to load camera stream.")
        );
      };
      video.addEventListener("loadeddata", onLoaded);
      video.addEventListener("error", onError);
    });

    try {
      await video.play();
    } catch (error) {
      console.warn(
        "[TV Agentic Flow] Unable to autoplay the camera stream.",
        error
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    this.stream = stream;
    this.videoElement = video;
    this.canvasElement = canvas;

    console.info(
      "[TV Agentic Flow] Camera ready. Captures will run in the background."
    );
  }

  async ensureCamera(): Promise<void> {
    if (this.stream) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = this.startCamera().catch((error) => {
        // Reset promise so future attempts can retry.
        this.initPromise = undefined;
        throw error;
      });
    }

    await this.initPromise;
  }

  async capture(stepIndex: number): Promise<ScreenshotCapture> {
    try {
      await this.ensureCamera();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to initialize the camera for screenshot capture.";
      console.error(
        `[TV Agentic Flow] Camera initialization failed: ${message}`
      );
      return { error: message };
    }

    const video = this.videoElement;
    const canvas = this.canvasElement;

    if (!video || !canvas) {
      return {
        error: "Camera stream is not available for capturing screenshots.",
      };
    }

    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          video.removeEventListener("loadeddata", handler);
          resolve();
        };
        video.addEventListener("loadeddata", handler);
      });
    }

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return {
        error: "Unable to access the canvas context for screenshot capture.",
      };
    }

    context.drawImage(video, 0, 0, width, height);

    try {
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const [, base64] = dataUrl.split(",");
      if (!base64) {
        throw new Error("Failed to encode the captured frame.");
      }
      console.info(
        `[TV Agentic Flow] Captured screenshot for step ${stepIndex}. Screenshot will be saved on server.`
      );

      return {
        dataUrl,
        base64,
        contentType: "image/jpeg",
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to capture screenshot from the camera stream.";
      console.error(`[TV Agentic Flow] Screenshot capture failed: ${message}`);
      return { error: message };
    }
  }

  isActive(): boolean {
    return Boolean(this.stream);
  }

  async stop(): Promise<void> {
    const hadStream = Boolean(this.stream);

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.stream = null;
    this.videoElement = undefined;
    this.canvasElement = undefined;
    this.initPromise = undefined;

    if (hadStream) {
      console.info("[TV Agentic Flow] Released the local camera stream.");
    }
  }
}

export const tvCameraController = new TvCameraController();

export async function captureTvScreenshot(
  stepIndex: number
): Promise<ScreenshotCapture> {
  return tvCameraController.capture(stepIndex);
}
