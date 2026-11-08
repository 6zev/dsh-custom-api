# DSH Custom API — Model Discovery & Capability Enhancer

<p align="center">
  <img src="./icon.svg" width="80" height="80" alt="DSH Custom API Logo" />
</p>

Plugin mở rộng cho **DeepSeek Harness (DSH)**, kết hợp **API Endpoint Metadata**, cơ sở dữ liệu mở **[Models.dev](https://models.dev/)** và bộ quy chuẩn **Vendor Reasoning Ladders** (tham khảo từ [dsh-dc-ai-api](https://github.com/dabeecao/dsh-dc-ai-api)) để tự động khám phá và cấu hình hoàn chỉnh các model từ Custom API:
- 🖼️ **Vision (Multimodal Image Input)**: Nhận diện model đa phương thức, tự gán `input: ["text", "image"]`.
- 🧠 **Thinking / Reasoning Effort**: Gán chuẩn thang đo suy nghĩ của từng hãng (`none/low/high/max` cho DeepSeek, 5 mức cho Claude & OpenAI, Flash ladder cho Gemini, v.v.).
- 🛠️ **Tool Calling**: Đảm bảo tương thích hoàn toàn cho việc gọi Function / Tools của Agent.
- 📏 **Context Window & Max Tokens**: Trích xuất kích thước ngữ cảnh và kẹp giới hạn token chuẩn xác.

---

## 🚀 Cài Đặt

### 1. Cài đặt qua npm registry
```bash
dsh plugin --profile web add dsh-custom-api
```

### 2. Cài đặt trực tiếp từ GitHub
```bash
dsh plugin --profile web add github:6zev/dsh-custom-api
```

---

## 🌟 Tính Năng Nổi Bật

### 1. Phân Tích Khả Năng Model 3 Tầng (Không Đoán Mò)
1. **Tier 1 - Trực tiếp từ API Endpoint Metadata**:
   - Trích xuất các trường `architecture.modality`, `modalities.input`, `supported_parameters`, `capabilities`, `features`, `model_info`.
2. **Tier 2 - Tra cứu [Models.dev](https://models.dev/) Database**:
   - Tự động cache và đối soát hơn 4.800+ models từ cơ sở dữ liệu mở quốc tế [Models.dev](https://models.dev/).
   - Trích xuất chính xác giới hạn context, output tokens, cờ vision và reasoning.
3. **Tier 3 - Heuristic Fallback**:
   - Dự phòng thông minh cho các model nội bộ mới ra mắt.

### 2. Thang Đo Reasoning Chuẩn Theo Từng Hãng (Vendor Ladders)
| Hãng (Family) | Thang đo Thinking Effort | Đặc điểm |
| :--- | :--- | :--- |
| **DeepSeek** | `none` / `low` / `high` / `max` | `thinkingFormat: "deepseek"` |
| **OpenAI (GPT / o-series)** | `low` / `medium` / `high` / `xhigh` / `max` | Chuẩn 5 mức OpenAI |
| **Google Gemini** | Theo từng model (`GEMINI_LEVELS`): `minimal`, `low`, `medium`, `high` | Không có `max` |
| **Anthropic Claude** | `low` / `medium` / `high` / `xhigh` / `max` | Chuẩn Claude 3.7+ |
| **xAI Grok** | `low` / `medium` / `high` / `xhigh` | Không có `off` |
| **Zhipu GLM** | `none` / `high` / `max` | Chuẩn GLM-5.2+ |
| **Qwen & Khác** | Toggle only (`off: null`, `high: high`) | Bật/tắt suy nghĩ |
| **Model thường** | `reasoningEfforts: false` | Tắt hoàn toàn thinking |

### 3. Lọc Bỏ Endpoint Thuần Sinh Ảnh
- Tự động loại bỏ các endpoint như `gpt-image-*`, `grok-imagine-*`, `flux`, `midjourney` khỏi Chat Catalog để tránh lỗi giao thức.

---

## 📖 Cách Sử Dụng

### 1. Dùng Slash Command trong chat
- Quét API và cấu hình ngay vào DSH:
  ```text
  /discover-models https://api.your-relay.com/v1 sk-xxxx my-provider
  ```
- Nâng cấp toàn bộ model hiện có trong DSH:
  ```text
  /enhance-models
  ```

### 2. Dùng Web UI Settings
1. Vào **Settings -> Models -> Custom model API**.
2. Nhập URL và API Key, bấm **Fetch models**. Plugin sẽ can thiệp để danh sách model trả về đã nhận diện sẵn Vision và Thinking.

### 3. Giao việc cho AI Agent
Bạn chỉ cần nhắn cho AI:
> *"Quét endpoint https://dc-ai.dabeecao.org/v1 với API key ... và lưu vào DSH giúp tôi"*

---

## 🔐 Cấu Hình Trusted Publisher (npm)

Workflow GitHub Actions (`.github/workflows/publish.yml`) đã được tích hợp sẵn quyền OIDC `id-token: write` và cờ `--provenance`.

Để liên kết Trusted Publisher trên npm:
1. Truy cập: [https://www.npmjs.com/package/dsh-custom-api/access](https://www.npmjs.com/package/dsh-custom-api/access)
2. Trong phần **Publishing Access** $\rightarrow$ **Trusted Publishers**, chọn **Add Trusted Publisher** $\rightarrow$ **GitHub Actions**.
3. Điền:
   - **Repository Owner**: `6zev`
   - **Repository Name**: `dsh-custom-api`
   - **Workflow filename**: `publish.yml`
4. Từ các lần phát hành tiếp theo, GitHub Actions sẽ tự động xác thực và ký số Provenance mà không cần secret token tĩnh.

---

## 📄 Giấy Phép

MIT License © 2026 [6zev](https://github.com/6zev)
