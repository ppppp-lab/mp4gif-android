# MP4GIF AI Function Call Model

## Model

- Name: mp4gif-ai
- Version: 0.1.0
- Base: Qwen2.5-0.5B-Instruct
- Format: GGUF, mixed quantization targeting Q4_K_M
- Size: 379.38 MB
- File: mp4gif-ai.gguf

## SHA-256

```
23FE15B6207B71EEF275885D33D2B76A8CC64D55EC2222F50008F7C1694118E4
```

## Usage

The app downloads this file to its private model directory, verifies the
SHA-256, then loads it with llama.cpp. The model is trained to translate
Chinese instructions into JSON function calls for the meme editor.
