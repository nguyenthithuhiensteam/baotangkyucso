# Bảo tàng ký ức số – Trường Mầm non Nông Tiến

Hướng dẫn đưa trang lên GitHub Pages và quản trị dữ liệu.

## Bộ tệp gồm

| Tệp | Công dụng |
|---|---|
| `index.html` | Toàn bộ trang bảo tàng (giao diện + khu quản trị) |
| `data/museum.json` | Dữ liệu: hiện vật, mốc lịch sử, link phòng 3D, video |
| `.nojekyll` | Giúp GitHub Pages phục vụ đúng thư mục `data` |
| `HUONG-DAN.md` | Tệp này |

## Bước 1. Tạo tài khoản và kho (làm 1 lần)

1. Vào https://github.com, tạo tài khoản bằng email của trường (ví dụ tên tài khoản `mnnongtien`).
2. Bấm **New repository** (nút `+` góc trên bên phải).
3. **Repository name**: `bao-tang-ky-uc`. Chọn **Public** (GitHub Pages miễn phí cần kho công khai).
4. Bấm **Create repository**.

## Bước 2. Tải tệp lên

1. Trong kho vừa tạo, bấm **uploading an existing file**.
2. Giải nén tệp zip, kéo **cả thư mục `data`, tệp `index.html` và `.nojekyll`** vào khung tải lên.
   - Tệp `.nojekyll` bị ẩn trên máy: trên Windows bật “Hiện tệp ẩn” trong File Explorer; trên Mac bấm Cmd + Shift + dấu chấm.
3. Bấm **Commit changes**.
4. Kiểm tra trong kho có đường dẫn `data/museum.json`.

## Bước 3. Bật GitHub Pages

1. Vào **Settings** › **Pages**.
2. **Source**: chọn *Deploy from a branch*; **Branch**: `main`, thư mục `/ (root)`. Bấm **Save**.
3. Sau 1–2 phút, trang có địa chỉ: `https://mnnongtien.github.io/bao-tang-ky-uc/`
   (thay `mnnongtien` bằng tên tài khoản của trường).

## Bước 4. Tạo mã truy cập cho người quản trị

1. Vào ảnh đại diện › **Settings** › **Developer settings** › **Personal access tokens** › **Fine-grained tokens** › **Generate new token**.
2. **Token name**: `Quan tri bao tang`. **Expiration**: chọn 90 ngày hoặc đến hết năm học.
3. **Repository access**: *Only select repositories* › chọn `bao-tang-ky-uc`.
4. **Permissions** › **Repository permissions** › **Contents**: chọn **Read and write**.
5. Bấm **Generate token**, sao chép mã (bắt đầu bằng `github_pat_`). Mã chỉ hiện một lần.

## Bước 5. Quản trị trên trang

1. Mở trang, kéo xuống cuối, bấm **Quản trị** (hoặc thêm `#quan-tri` vào cuối địa chỉ).
2. Nhập tài khoản, tên kho, nhánh `main` và mã truy cập › **Đăng nhập**.
3. Thêm, sửa, xóa hiện vật; dán link video, âm thanh, phòng 3D, thư mục Drive.
4. Bấm **Đưa vào danh sách** sau mỗi mục, rồi **Lưu lên trang** ở thanh dưới cùng.
5. Phụ huynh thấy bản mới sau khoảng 1–2 phút.

Mã truy cập chỉ lưu trên trình duyệt của máy đang dùng. Dùng máy chung thì bấm **Đăng xuất** khi xong.
Nhiều người cùng quản trị: mỗi người tạo mã riêng; trước khi sửa bấm **Tải bản mới nhất**.

## Chạy trên tên miền riêng (baotang.nguyenhiensteam.vn)

Kho đang dùng: `https://github.com/nguyenthithuhiensteam/baotangkyucso`. Trang được phục vụ qua Vercel (cùng nơi với nguyenhiensteam.vn), không cần bật GitHub Pages.

1. Vào https://vercel.com › **Add New… › Project** › chọn kho `baotangkyucso` › **Import**.
   - Framework Preset: **Other**; Build Command và Output Directory để trống › **Deploy**.
2. Trong dự án vừa tạo: **Settings › Domains** › nhập `baotang.nguyenhiensteam.vn` › **Add**.
3. Vào trang quản lý tên miền Tenten (tenten.vn) › tên miền `nguyenhiensteam.vn` › **Quản lý DNS** › thêm bản ghi:
   - Loại: `CNAME` · Tên (Host): `baotang` · Giá trị: `cname.vercel-dns.com` (hoặc giá trị Vercel hiển thị ở bước 2).
4. Chờ 5–30 phút, Vercel báo **Valid Configuration** và tự cấp chứng chỉ HTTPS.

Khi quản trị viên bấm **Lưu lên trang**, GitHub nhận bản mới và Vercel tự đăng lại sau khoảng 1 phút. Khu quản trị đã điền sẵn tài khoản `nguyenthithuhiensteam` và kho `baotangkyucso`; ở Bước 4 chọn kho `baotangkyucso` khi tạo mã.

## Lưu ý về dữ liệu của trẻ

- Kho GitHub là **công khai**: ai cũng đọc được tệp `data/museum.json`. Chỉ ghi câu chuyện đã viết lại và đường link, **không** ghi họ tên đầy đủ, ảnh hay giọng nói của trẻ.
- Video, ghi âm có mặt hoặc giọng trẻ để trên Google Drive tổ chức của trường, chia sẻ nội bộ; trên trang chỉ dán link Drive.
- Thực hiện theo Mục II.3 Kế hoạch số 17/KH-MNNT và Quy chế ban hành kèm Quyết định số 24/QĐ-MNNT.

## Khi gặp lỗi

| Thông báo | Cách xử lý |
|---|---|
| Mã truy cập không đúng hoặc đã hết hạn | Tạo mã mới ở Bước 4 |
| Không tìm thấy kho | Kiểm tra tên tài khoản, tên kho; mã đã chọn đúng kho chưa |
| Token chỉ có quyền đọc | Sửa mã: Contents › Read and write |
| Kho chưa có tệp data/museum.json | Tải lại thư mục `data` ở Bước 2 |
| Có người vừa lưu bản khác | Bấm **Tải bản mới nhất**, làm lại thay đổi rồi lưu |
