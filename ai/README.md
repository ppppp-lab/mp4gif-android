# AI 函数调用交付包

用途：让本地小模型把中文口语指令转成 App 可执行的 JSON 函数调用。

## 文件

- `function-call-spec.md`：函数调用接口规范、method 白名单、参数范围和校验规则。
- `function_call.gbnf`：llama.cpp GBNF 语法，约束模型只输出合法 JSON。
- `ai_training_data.jsonl`：960 条中文指令到函数调用数组的训练数据。
- `generate_dataset.py`：训练集生成脚本，可重复生成并自动校验。
- `AiDispatcher.kt`：Kotlin 分发、白名单校验、魔搭下载、assets 读取参考代码。
- `lora_train.yaml`：Llama-Factory LoRA 训练配置。
- `training-config.md`：环境、训练、评估、量化、上传和 Android 推理配置说明。

## 当前约定

- 模型使用 `Qwen2.5-0.5B-Instruct` LoRA 微调。
- 模型文件不超过 500MB，优先导出 `Q4_K_M`。
- 模型不进 APK，App 启动后从魔搭下载。
- 模型输出统一为函数数组，Kotlin 逐条校验后分发。
- AI 仅开放表情包工坊控制；MP4 转 GIF、相机、首页、隐私页不在白名单内。
