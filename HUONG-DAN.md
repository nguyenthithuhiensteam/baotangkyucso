# Bảo tàng ký ức số – Trường Mầm non Nông Tiến

Trang công khai: **https://baotang.nguyenhiensteam.vn**
Khu quản trị: **https://baotang.nguyenhiensteam.vn/#quan-tri**

## Bộ tệp gồm

| Tệp | Công dụng |
|---|---|
| `index.html` | Toàn bộ trang bảo tàng (giao diện + khu quản trị) |
| `data/museum.json` | Dữ liệu công khai: hiện vật, mốc lịch sử, link phòng 3D, video (6 phòng, có Phòng 6 · Góc thiên nhiên xanh) |
| `server/` | Máy chủ quản trị: đăng nhập, phân quyền, duyệt bài |
| `.nojekyll` | Dùng khi chạy trên GitHub Pages (không bắt buộc) |

## Cách hệ thống hoạt động

- **Trang công khai** (Render Static Site `baotangkyucso`) đọc `data/museum.json` trong kho `nguyenthithuhiensteam/baotangkyucso`.
- **Máy chủ quản trị** (Render Web Service `baotangkyucso-api`) giữ mã GitHub. Giáo viên đăng nhập bằng tên + mật khẩu, không cần GitHub.
- **Tài khoản và bài chờ duyệt** lưu trong kho **riêng tư** `nguyenthithuhiensteam/baotangkyucso-quantri` (tệp `quantri.json`), không ai bên ngoài đọc được.

## Phân quyền

| | Quản trị (1 tài khoản) | Giáo viên |
|---|---|---|
| Thêm, sửa hiện vật | Mọi phòng | Chỉ phòng được giao |
| Xóa hiện vật, mốc | Có | Không |
| Thêm, sửa mốc lịch sử (Phòng 4) | Có | Khi được bật quyền |
| Số liệu đầu trang, link phòng 3D, video chung | Có | Không |
| Bài lên trang | Ngay khi bấm Lưu | Chờ quản trị duyệt (hoặc đăng thẳng nếu quản trị tắt “cần duyệt”) |
| Tạo, sửa, khóa, xóa tài khoản | Có | Không |
| Tự đổi mật khẩu | Có | Có |

Quyền được máy chủ kiểm tra, giáo viên không thể tự vượt quyền.

## Cài đặt lần đầu (làm 1 lần)

### Bước 1. Tạo kho riêng tư trên GitHub

1. Vào https://github.com/new
2. **Repository name**: `baotangkyucso-quantri` · chọn **Private** · tích **Add a README file** › **Create repository**.

### Bước 2. Tạo mã GitHub cho máy chủ

1. Vào https://github.com/settings/personal-access-tokens/new
2. **Token name**: `May chu bao tang` · **Expiration**: chọn ngày hết năm học.
3. **Repository access**: *Only select repositories* › chọn **cả hai** kho `baotangkyucso` và `baotangkyucso-quantri`.
4. **Permissions** › **Contents**: **Read and write** › **Generate token** › sao chép mã `github_pat_…`.

### Bước 3. Tạo máy chủ trên Render

1. Vào https://dashboard.render.com › **+ New** › **Web Service** › chọn kho `baotangkyucso`.
2. Điền:
   - **Name**: `baotangkyucso-api` (địa chỉ sẽ là `https://baotangkyucso-api.onrender.com`)
   - **Branch**: `main` · **Root Directory**: `server`
   - **Runtime**: Node · **Build Command**: `npm install` · **Start Command**: `npm start`
   - **Instance Type**: Free
3. **Environment Variables** – thêm 3 biến:

| KEY | VALUE |
|---|---|
| `GITHUB_TOKEN` | mã `github_pat_…` ở Bước 2 |
| `ADMIN_PASSWORD` | mật khẩu quản trị, ít nhất 8 ký tự |
| `SESSION_SECRET` | bấm **Generate** để Render tự tạo |

4. **Deploy Web Service**. Khi thấy **Live**, mở `https://baotangkyucso-api.onrender.com/api/health` phải thấy `"configured":true`.

Tên đăng nhập quản trị mặc định là `quantri` (muốn đổi: thêm biến `ADMIN_USER`).

**Đổi mật khẩu quản trị:** đăng nhập `quantri` › thẻ **Đổi mật khẩu** (ít nhất 8 ký tự). **Quên mật khẩu:** trên Render đặt giá trị mới cho `ADMIN_PASSWORD` › Save; mật khẩu đó sẽ thay mật khẩu đã đổi trên trang.

## Sử dụng hằng ngày

**Quản trị:** mở `#quan-tri`, đăng nhập `quantri`.
- Thẻ **Tài khoản**: tạo tài khoản giáo viên, giao phòng, bật/tắt “cần duyệt”, quyền dòng thời gian; khóa hoặc xóa tài khoản.
- Thẻ **Duyệt bài**: xem nội dung giáo viên gửi › **Duyệt, đưa lên trang** hoặc **Trả lại** kèm lý do.
  - **Lọc trùng:** giáo viên gửi lại cùng một hiện vật/mốc khi bài trước còn chờ thì máy chủ tự gộp, chỉ giữ bản mới nhất (ghi “Đã gửi lại n lần”). Nếu **hai người khác nhau** cùng sửa một hiện vật, thẻ Duyệt bài hiện cảnh báo ⚠: duyệt bài sau sẽ ghi đè bài trước.
- Thẻ **Lớp học**: nhập tên các điểm trường và danh sách lớp (mỗi dòng một lớp) › **Đưa vào danh sách** › **Lưu lên trang**. Khi thêm/sửa hiện vật, chọn **Lớp**; trong mỗi phòng phụ huynh lọc theo điểm trường và lớp.
- Thẻ **Giới thiệu & link chung**: sửa các con số đầu trang (điểm trường, phân hiệu, nhóm lớp, cô giáo, học sinh), link phòng 3D, video giới thiệu.
- Sửa trực tiếp hiện vật, mốc, link › **Lưu lên trang**.

**Ảnh thật:** khi thêm/sửa hiện vật, bấm **Chọn tệp** ở ô *Ảnh thật* (máy tính hoặc điện thoại). Ảnh tự thu nhỏ (cạnh dài ≤ 1600px), bỏ thông tin vị trí GPS, rồi lưu trong thư mục `anh/` của kho công khai. Ảnh của giáo viên cần duyệt được giữ ở kho riêng tư cho tới khi quản trị duyệt. **Không đăng ảnh rõ mặt trẻ** khi chưa có đồng ý của cha mẹ.

**Giáo viên:** mở `#quan-tri`, đăng nhập bằng tài khoản được cấp › thêm/sửa hiện vật › **Gửi để duyệt**. Theo dõi kết quả ở thẻ **Bài đã gửi**.

Gói miễn phí của Render cho máy chủ ngủ sau 15 phút không dùng: lần đăng nhập đầu có thể chờ khoảng 1 phút. Trang công khai cho phụ huynh không bị ảnh hưởng.

## Lưu ý về dữ liệu của trẻ

- Kho `baotangkyucso` là **công khai**: ai cũng đọc được `data/museum.json`. Chỉ ghi câu chuyện đã viết lại và đường link, **không** ghi họ tên đầy đủ hay giọng nói của trẻ. Ảnh đã đăng (thư mục `anh/`) ai cũng xem được: chỉ đăng ảnh cây, đồ vật, sản phẩm, hoặc ảnh trẻ từ phía sau/không rõ mặt, trừ khi cha mẹ đã đồng ý.
- Video, ghi âm có mặt hoặc giọng trẻ để trên Google Drive tổ chức của trường, chia sẻ nội bộ; trên trang chỉ dán link Drive.
- Gửi mật khẩu cho từng giáo viên riêng, không gửi vào nhóm chung.
- Thực hiện theo Mục II.3 Kế hoạch số 17/KH-MNNT và Quy chế ban hành kèm Quyết định số 24/QĐ-MNNT.

## Khi gặp lỗi

| Thông báo | Cách xử lý |
|---|---|
| Không kết nối được máy chủ quản trị | Chờ 1 phút (máy chủ đang khởi động) rồi thử lại; kiểm tra dịch vụ `baotangkyucso-api` trên Render |
| Máy chủ chưa được cấu hình đủ | Kiểm tra 3 biến ở Bước 3 |
| Chưa có kho riêng tư … | Làm Bước 1; kiểm tra mã ở Bước 2 đã chọn cả kho riêng tư |
| Mã GitHub trên máy chủ không đúng hoặc đã hết hạn | Tạo mã mới (Bước 2), dán vào biến `GITHUB_TOKEN` trên Render |
| Có người vừa lưu hoặc vừa có bài được duyệt | Bấm **Tải bản mới nhất**, làm lại thay đổi rồi lưu |
| Nhập sai quá nhiều lần | Chờ 15 phút |
