# Trích Tinh Lâu · Control Center

Userscript Tampermonkey giúp gom các chức năng quản lý truyện và chương trên **Trích Tinh Lâu** vào một Control Center duy nhất.

## Cài đặt

Yêu cầu trình duyệt đã cài **Tampermonkey**.

[Nhấn vào đây để cài userscript](https://raw.githubusercontent.com/caccac11/TTL/main/trich-tinh-lau-control-center.user.js)

Tampermonkey sẽ tự mở màn hình cài đặt.

---

## Chức năng

### Tổng quan

Hiển thị nhanh tình trạng truyện đang chọn:

- tổng số chương;
- số chương miễn phí;
- số chương mở bằng Sao;
- số chương mở bằng Kim cương;
- cảnh báo chương dưới 1000 từ nhưng vẫn đang để trả phí.

### Quản lý truyện

- tải danh sách truyện;
- lọc nhanh theo tên hoặc ID;
- tìm truyện bằng chức năng search của server;
- tạo truyện;
- sửa metadata truyện;
- publish / tạm ẩn;
- đọc form thật từ server thay vì hardcode field cố định.

### Quản lý chương

- tải toàn bộ danh sách chương của truyện;
- map bảng theo tên header, không phụ thuộc vị trí cột;
- lọc theo tên, slug, số chương, trạng thái;
- lọc chương trả phí;
- lọc chương dưới 1000 từ;
- tạo chương mới;
- sửa chương;
- chỉnh pass;
- chỉnh Sao / Kim cương;
- đăng ngay hoặc hẹn giờ;
- cập nhật nội dung và word count;
- xóa chương với xác nhận nhiều lớp.

### Bulk

Hỗ trợ xử lý nhiều chương từ TXT có dạng:

```text
CHƯƠNG 96: Tên chương

Nội dung chương 96...

CHƯƠNG 97: Tên chương

Nội dung chương 97...
```

Các tác vụ:

- Fix giá chương cũ hàng loạt;
- cập nhật tên + nội dung;
- chỉ đổi tên;
- chỉ cập nhật nội dung;
- đăng chương mới hàng loạt.

Quy tắc giá:

- dưới 1000 từ: bắt buộc FREE;
- Sao: 1–10;
- Kim cương: 1;
- một chương chỉ dùng một kiểu mở khóa.

Có preview trước khi chạy, delay giữa request, cooldown, hủy batch, re-check server và chống đăng trùng.

### Doanh thu

Dashboard doanh thu được rút gọn, không nhúng toàn bộ giao diện gốc của website.

Hiển thị:

- số tiền có thể rút;
- số dư Kim cương hiện tại;
- tổng Kim cương đã thu;
- tổng lượt bán;
- doanh thu tháng hiện tại;
- danh sách từng truyện kèm số lượt bán và số Kim cương đã thu.

Truyện đang được chọn trong Control Center sẽ được highlight.

### Log

Ghi lại các thao tác, cảnh báo, lỗi request và kết quả batch.

---

## Nguyên tắc hoạt động

Script ưu tiên lấy cấu trúc thật từ website:

- đọc `form action`;
- đọc HTTP method;
- đọc CSRF / hidden field;
- đọc tên field;
- đọc header bảng;
- re-fetch dữ liệu server sau thao tác ghi.

Mục tiêu là giảm phụ thuộc vào DOM cố định và hạn chế lỗi khi website thay đổi thứ tự cột hoặc thêm field.

---

## An toàn

Các thao tác ghi dữ liệu không được chạy âm thầm.

- tạo / sửa cần thao tác trực tiếp của người dùng;
- publish / tạm ẩn có confirm;
- xóa chương cần confirm và nhập lại số chương;
- bulk cần confirm trước khi chạy;
- sau mutation quan trọng script re-check dữ liệu server.

Script không chứa cookie, mật khẩu, CSRF token hoặc ID tài khoản cố định. Nó dùng phiên đăng nhập hiện tại của người đang sử dụng website.

---

## Cập nhật

Userscript có cấu hình auto-update từ GitHub.

Khi phát hành bản mới:

1. tăng `@version`;
2. cập nhật file:
   `trich-tinh-lau-control-center.user.js`
3. commit lên nhánh `main`.

Tampermonkey của người dùng sẽ kiểm tra bản mới theo `@updateURL`.

---

## Repository

https://github.com/caccac11/TTL

## Báo lỗi

https://github.com/caccac11/TTL/issues

---

## License

MIT
