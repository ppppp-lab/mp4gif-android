# 训练与推理配置

## 1. 方案结论

不再从零训练。使用 `Qwen/Qwen2.5-0.5B-Instruct` 做 LoRA 微调，训练完成后合并 LoRA，导出 GGUF，上传魔搭，Android 启动后从魔搭下载模型文件。

当前机器：RTX 3060 12GB，适合本方案训练。建议使用 Python 3.12 虚拟环境。

## 2. 环境准备

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -U pip
git clone https://github.com/hiyouga/LLaMA-Factory.git
cd LLaMA-Factory
pip install -e ".[torch]"
```

如果 PyTorch 默认源不带 CUDA，可手动安装 CUDA 12.8 版本：

```powershell
pip install torch --index-url https://download.pytorch.org/whl/cu128
```

## 3. 数据集

`ai_training_data.jsonl` 共 3000 条，格式：

```json
{"instruction":"做个表情包，加文字哈哈，然后导出","output":"[{\"method\":\"open_page\",\"params\":{\"page\":\"meme\"}},{\"method\":\"open_text_editor\",\"params\":{}},{\"method\":\"add_text\",\"params\":{\"text\":\"哈哈\"}},{\"method\":\"export_meme\",\"params\":{}}]"}
```

在 `LLaMA-Factory/data/dataset_info.json` 注册：

```json
{
  "ai_function_call": {
    "file_name": "ai_training_data.jsonl",
    "columns": {
      "prompt": "instruction",
      "query": "",
      "response": "output"
    },
    "formatting": "alpaca"
  }
}
```

切分建议：`val_size: 0.1`，即 2700 条训练、300 条测试。测试集只用于训练后评估，不混入训练。

## 4. LoRA 训练参数

使用同目录 `lora_train.yaml`：

- 基座：`Qwen2.5-0.5B-Instruct`
- `r=16`、`alpha=32`
- `learning_rate=2e-4`
- `num_train_epochs=12`
- `per_device_train_batch_size=8`
- `gradient_accumulation_steps=4`
- `fp16=true`
- 不使用 QLoRA、不使用 `bitsandbytes`

启动训练：

```powershell
llamafactory-cli train lora_train.yaml
```

## 5. 测试集评估

训练完成后，用测试集评估正确率：

1. 对 300 条测试指令逐条生成函数调用。
2. 与标注输出比较 method 序列。
3. 再比较每个 method 的参数。
4. 记录 `method 准确率` 和 `完整 JSON 准确率`。

若完整 JSON 准确率过低，优先增加数据变体或提高 `epochs`，不建议继续增大模型。

## 6. 合并与量化

合并 LoRA：

```powershell
llamafactory-cli export \
  --model_name_or_path Qwen/Qwen2.5-0.5B-Instruct \
  --adapter_name_or_path outputs/mp4gif-ai-lora \
  --template qwen \
  --finetuning_type lora \
  --export_dir outputs/mp4gif-ai-merged \
  --export_size 4 \
  --export_legacy_format false
```

转 GGUF：

```powershell
git clone https://github.com/ggml-org/llama.cpp
python llama.cpp/convert_hf_to_gguf.py outputs/mp4gif-ai-merged `
  --outfile outputs/mp4gif-ai-f16.gguf --outtype f16
```

量化：

```powershell
llama.cpp\build\bin\Release\llama-quantize.exe `
  outputs\mp4gif-ai-f16.gguf `
  outputs\mp4gif-ai-q4_k_m.gguf `
  Q4_K_M
```

体积预期：

- `Q4_K_M`：约 330-400MB，首选。
- `Q5_K_M`：约 430MB，次选。
- `Q8_0`：约 500MB 以上，不建议。

## 7. 上传魔搭

```powershell
pip install modelscope
modelscope login
modelscope upload --model 你的用户名/你的仓库名 outputs/mp4gif-ai-q4_k_m.gguf
```

上传后在魔搭仓库设置公开可见。Android 侧使用直链：

```text
https://modelscope.cn/models/你的用户名/你的仓库名/resolve/master/mp4gif-ai-q4_k_m.gguf?download=true
```

同时记录文件 SHA256，作为下载校验值。

## 8. Android 推理参数

- `n_ctx=1024`
- `n_batch=256`
- `temperature=0.2`
- `top_k=40`
- `top_p=0.9`
- `repeat_penalty=1.1`
- `max_new_tokens=256`
- 必须开启 GBNF，使用 `function_call.gbnf`

加载和推理必须在后台线程执行。模型文件放 `filesDir/models/mp4gif-ai.gguf`。

## 9. APK 与模型体积

- 模型不打进 APK，APK 保持轻量。
- 正式包可只保留 `arm64-v8a` 以进一步缩小 APK；若需要模拟器调试再补 `x86_64`。
- 手机第一次启动时后台下载模型，显示进度，不阻塞正常功能。
- 下载失败不崩，下次启动自动重试。
