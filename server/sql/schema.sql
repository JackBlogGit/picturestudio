-- =============================================================================
-- 工作室漫展返图 & 文件共享平台  数据库最终版 V1.2
-- 目标：MySQL 8.0+ / InnoDB / utf8mb4
-- 说明：本文件可直接执行。相比 PRD V1.0 的建表脚本，补齐了缺失表、字段与索引，
--       并修正了权限语义冲突。变更清单见 PRD-V1.2.md 第 2 章。
--       V1.2 第 19 章附录 A 的增量（临时账号工单字段、files 工单附件、3 项站点配置）
--       已并入下方建表语句；已部署库的升级走 migrations/*-AddTempAccountTaskFields。
-- 若为 MySQL 5.7：把所有 utf8mb4_0900_ai_ci 替换为 utf8mb4_general_ci，
--       并把 `filter_json JSON` 改为 TEXT。
-- =============================================================================

CREATE DATABASE IF NOT EXISTS piks_photo
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_0900_ai_ci;
USE piks_photo;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. 四级正式用户表
--    变更：新增 nickname（用于摄影师标签自动补全）、last_login_time、update_time
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    username        VARCHAR(50)  NOT NULL COMMENT '账号',
    password        VARCHAR(100) NOT NULL COMMENT 'bcrypt 密文，禁止明文',
    nickname        VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '昵称/展示名',
    level           TINYINT UNSIGNED NOT NULL COMMENT '4超管 3管理员 2普通成员 1见习成员',
    space_quota     BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '存储配额(字节)，0=不限',
    used_space      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已用空间(字节)',
    status          TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
    remark          VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注(职责/联系方式)',
    last_login_time DATETIME NULL,
    create_time     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_username (username),
    KEY idx_level_status (level, status)
) ENGINE = InnoDB COMMENT '四级正式成员';

-- -----------------------------------------------------------------------------
-- 2. 站点配置表（V1.0 缺失：6.2 站点设置/水印/上传限制/白名单无落库位置）
--    KV 结构，值统一存 JSON 字符串，读取时按 skey 解析
-- -----------------------------------------------------------------------------
CREATE TABLE site_settings (
    skey        VARCHAR(64) PRIMARY KEY COMMENT 'upload.max_file_size / watermark.enabled 等',
    sval        TEXT        NOT NULL COMMENT 'JSON 值',
    remark      VARCHAR(255) NOT NULL DEFAULT '',
    update_uid  INT UNSIGNED NULL,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_settings_uid FOREIGN KEY (update_uid) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB COMMENT '站点全局配置';

-- -----------------------------------------------------------------------------
-- 3. 全局标签库表
--    变更：新增 merged_into（重命名/合并时的迁移指向）、use_count（6 频次统计）
-- -----------------------------------------------------------------------------
CREATE TABLE tags (
    id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    tag_type    ENUM('event','coser','role','photographer','status') NOT NULL COMMENT '标签类型',
    tag_name    VARCHAR(100) NOT NULL COMMENT '标签名称',
    alias       VARCHAR(100) NOT NULL DEFAULT '' COMMENT '别名，用于自动补全命中',
    merged_into INT UNSIGNED NULL COMMENT '已合并到的标签ID，非NULL即本标签停用',
    use_count   INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '使用频次，异步维护',
    create_uid  INT UNSIGNED NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_type_name (tag_type, tag_name),
    KEY idx_merged (merged_into),
    KEY idx_type_count (tag_type, use_count),
    CONSTRAINT fk_tags_create_uid FOREIGN KEY (create_uid) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_tags_merged FOREIGN KEY (merged_into) REFERENCES tags (id) ON DELETE SET NULL
) ENGINE = InnoDB COMMENT '全局标签库';

-- -----------------------------------------------------------------------------
-- 4. 漫展相册表
--    变更：新增 status（4.2 要求归档/锁定，V1.0 无字段）、description、update_time
-- -----------------------------------------------------------------------------
CREATE TABLE albums (
    id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    parent_id   INT UNSIGNED NULL COMMENT '父相册ID，顶级NULL；仅L4超管可创建子相册',
    name        VARCHAR(100) NOT NULL COMMENT '相册名称',
    event_name  VARCHAR(100) NOT NULL DEFAULT '' COMMENT '漫展名称',
    event_date  DATE NULL COMMENT '漫展日期',
    location    VARCHAR(150) NOT NULL DEFAULT '',
    description VARCHAR(500) NOT NULL DEFAULT '',
    cover_img_id INT UNSIGNED NULL COMMENT '封面图片ID（刻意不加外键，见下方说明）',
    visibility  ENUM('public','member','admin','private') NOT NULL DEFAULT 'member' COMMENT '可见范围',
    status      TINYINT NOT NULL DEFAULT 1 COMMENT '1正常 2归档 3锁定(锁定后禁止上传/编辑)',
    create_uid  INT UNSIGNED NOT NULL COMMENT '创建人ID',
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_visibility_status (visibility, status),
    KEY idx_create_uid (create_uid),
    KEY idx_event_date (event_date),
    KEY idx_parent (parent_id),
    CONSTRAINT fk_albums_parent FOREIGN KEY (parent_id) REFERENCES albums (id) ON DELETE CASCADE,
    CONSTRAINT fk_albums_create_uid FOREIGN KEY (create_uid) REFERENCES users (id)
) ENGINE = InnoDB COMMENT '漫展相册（支持嵌套子相册）';

-- -----------------------------------------------------------------------------
-- 5. 返图图片表
--    变更：新增 shot_time(4.3 EXIF 必填)、file_size/width/height、watermarked、
--          md5、filename、sort、update_time；补齐索引与外键
-- -----------------------------------------------------------------------------
CREATE TABLE images (
    id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    album_id      INT UNSIGNED NOT NULL COMMENT '所属相册ID',
    original_path VARCHAR(255) NOT NULL COMMENT '原图存储路径(非Web可达目录)',
    preview_path  VARCHAR(255) NOT NULL COMMENT '预览图存储路径',
    thumb_path    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '列表缩略图路径',
    filename      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '上传时原始文件名',
    file_size     BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '原图字节数',
    width         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '原图宽(px)',
    height        INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '原图高(px)',
    md5           CHAR(32) NOT NULL DEFAULT '' COMMENT '原图MD5，用于秒传/查重',
    shot_time     DATETIME NULL COMMENT 'EXIF 拍摄时间，读取失败则为NULL',
    watermarked   TINYINT NOT NULL DEFAULT 0 COMMENT '1=预览图已叠加水印',
    visibility    ENUM('public','member','admin','private') NOT NULL DEFAULT 'member' COMMENT '不得宽于所属相册',
    sort          INT NOT NULL DEFAULT 0 COMMENT '相册内排序',
    upload_uid    INT UNSIGNED NOT NULL COMMENT '上传人ID',
    upload_temp_id INT UNSIGNED NULL COMMENT '非NULL=临时账号上传；此时 upload_uid 为该临时账号的 owner_uid',
    create_time   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_album_vis (album_id, visibility),
    KEY idx_upload_uid (upload_uid),
    KEY idx_shot_time (shot_time),
    KEY idx_md5 (md5),
    KEY idx_create_time (create_time),
    CONSTRAINT fk_images_album FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE CASCADE
) ENGINE = InnoDB COMMENT '漫展返图';

-- -----------------------------------------------------------------------------
-- 6. 临时账号表
--    变更：V1.0 只有 token 无法支持「账号密码登录」，现补 login_name / password /
--          display_name / allow_edit_tag / space_quota / used_space / owner_uid /
--          disabled；白名单由 TEXT 拆为独立关联表（可加索引与外键）
--    约束：access_token 与 login_name 至少配置一种（应用层校验）
--    V1.2（M2.5 / 附录 A）：+account_no（可登录的唯一帐户ID）、+phone（PII，出参必脱敏）、
--          +shooting_note，并作为第 17 章返图工单的宿主 +pre_stage / post_stage
--          与两个 done_time；已部署库的升级路径见 migrations/*-AddTempAccountTaskFields
-- -----------------------------------------------------------------------------
CREATE TABLE temp_accounts (
    id               INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    account_no       VARCHAR(16)  NOT NULL COMMENT '唯一帐户ID：YK+6位随机码，可替代 login_name 登录',
    access_token     VARCHAR(128) NULL COMMENT '一次性专属访问令牌',
    login_name       VARCHAR(50)  NULL COMMENT '临时登录账号名',
    password         VARCHAR(100) NULL COMMENT 'bcrypt；NULL 表示免密',
    display_name     VARCHAR(100) NOT NULL DEFAULT '' COMMENT '用途说明，如「XX漫展外聘-张三」',
    phone            VARCHAR(16)  NULL COMMENT '手机号，PII：响应与 logs 一律脱敏为 138****8000',
    shooting_note    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '拍摄内容（工单标题性说明）',
    expire_time      DATETIME NOT NULL COMMENT '到期自动失效',
    allow_preview    TINYINT NOT NULL DEFAULT 1 COMMENT '允许预览',
    allow_download   TINYINT NOT NULL DEFAULT 0 COMMENT '允许下载原图/原文件',
    allow_upload_img TINYINT NOT NULL DEFAULT 0 COMMENT '允许上传图片',
    allow_upload_file TINYINT NOT NULL DEFAULT 0 COMMENT '允许上传文件',
    allow_edit_tag   TINYINT NOT NULL DEFAULT 0 COMMENT '允许编辑标签',
    space_quota      BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '配额(字节)，0=不限',
    used_space       BIGINT UNSIGNED NOT NULL DEFAULT 0,
    owner_uid        INT UNSIGNED NOT NULL COMMENT '创建/负责的管理员ID，临时账号上传物归其名下',
    pre_stage        TINYINT NOT NULL DEFAULT 0 COMMENT '前期修图 0未完成 1已完成（PRD 17.2）',
    post_stage       TINYINT NOT NULL DEFAULT 0 COMMENT '后期返图 0未完成 1已完成（PRD 17.2）',
    pre_done_time    DATETIME NULL COMMENT '由后端在 pre_stage 置 1 时盖章，前端不可传',
    post_done_time   DATETIME NULL COMMENT '由后端在 post_stage 置 1 时盖章，前端不可传',
    disabled         TINYINT NOT NULL DEFAULT 0 COMMENT '1=被手动提前销毁',
    create_time      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_account_no (account_no),
    UNIQUE KEY uk_access_token (access_token),
    UNIQUE KEY uk_login_name (login_name),
    KEY idx_owner (owner_uid),
    KEY idx_expire (expire_time, disabled),
    KEY idx_stage_query (disabled, pre_stage, post_stage, create_time),
    CONSTRAINT fk_temp_owner FOREIGN KEY (owner_uid) REFERENCES users (id)
) ENGINE = InnoDB COMMENT '临时限时账号；同时是 PRD 第 17 章返图修图工单的宿主（D10）';

-- 白名单：可访问的相册（V1.0 用 TEXT 存数组，无法索引/校验，已规范化）
CREATE TABLE temp_account_albums (
    temp_id  INT UNSIGNED NOT NULL,
    album_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (temp_id, album_id),
    KEY idx_album (album_id),
    CONSTRAINT fk_taa_temp  FOREIGN KEY (temp_id)  REFERENCES temp_accounts (id) ON DELETE CASCADE,
    CONSTRAINT fk_taa_album FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE CASCADE
) ENGINE = InnoDB COMMENT '临时账号相册白名单';

-- 白名单：可访问的网盘文件夹（授权即含其全部子孙，见 PRD 5.5）
-- 注意：folders 尚未建表，其外键在 folders 建表后用 ALTER 补上
CREATE TABLE temp_account_folders (
    temp_id    INT UNSIGNED NOT NULL,
    folder_id  INT UNSIGNED NOT NULL,
    PRIMARY KEY (temp_id, folder_id),
    KEY idx_folder (folder_id),
    CONSTRAINT fk_taf_temp   FOREIGN KEY (temp_id)   REFERENCES temp_accounts (id) ON DELETE CASCADE
) ENGINE = InnoDB COMMENT '临时账号文件夹白名单';

ALTER TABLE images
    ADD CONSTRAINT fk_images_temp FOREIGN KEY (upload_temp_id) REFERENCES temp_accounts (id) ON DELETE SET NULL;

-- 说明：albums.cover_img_id 刻意不加外键。它与 images.album_id 构成循环引用，
-- 级联删除相册时 MySQL 会因约束顺序报错。封面图清理由应用层在删除图片事务内完成。

-- -----------------------------------------------------------------------------
-- 7. 图片-标签关联表
--    变更：补 tag_id 反查索引（筛选核心路径）、外键
-- -----------------------------------------------------------------------------
CREATE TABLE image_tag_map (
    id       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    image_id INT UNSIGNED NOT NULL,
    tag_id   INT UNSIGNED NOT NULL,
    UNIQUE KEY uk_img_tag (image_id, tag_id),
    KEY idx_tag (tag_id),
    CONSTRAINT fk_itm_image FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE,
    CONSTRAINT fk_itm_tag   FOREIGN KEY (tag_id)   REFERENCES tags (id) ON DELETE CASCADE
) ENGINE = InnoDB COMMENT '图片标签多对多';

-- -----------------------------------------------------------------------------
-- 8. Coser 返图分享链接表
--    变更：新增 snapshot + filter_json（V1.0 只支持单个 coser 标签，无法承载
--          「角色+摄影师」组合筛选结果）、visit_count、revoked、last_visit_time
-- -----------------------------------------------------------------------------
CREATE TABLE coser_share_links (
    id             INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    share_token    VARCHAR(128) NOT NULL COMMENT '分享令牌',
    album_id       INT UNSIGNED NOT NULL COMMENT '所属相册',
    coser_tag_id   INT UNSIGNED NULL COMMENT '关联Coser标签ID；snapshot=1 时可为NULL',
    filter_json    JSON NULL COMMENT '生成时的完整筛选条件快照',
    snapshot       TINYINT NOT NULL DEFAULT 0 COMMENT '0=按标签实时命中 1=固化图片集合',
    password       VARCHAR(100) NULL COMMENT 'bcrypt；NULL 表示无访问密码',
    allow_download TINYINT NOT NULL DEFAULT 0 COMMENT '允许访客下载原图',
    visit_count    INT UNSIGNED NOT NULL DEFAULT 0,
    expire_time    DATETIME NOT NULL,
    revoked        TINYINT NOT NULL DEFAULT 0 COMMENT '1=手动注销',
    create_uid     INT UNSIGNED NOT NULL,
    create_time    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_visit_time DATETIME NULL,
    UNIQUE KEY uk_share_token (share_token),
    KEY idx_album_coser (album_id, coser_tag_id),
    KEY idx_expire (expire_time, revoked),
    KEY idx_create_uid (create_uid),
    CONSTRAINT fk_csl_album FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE CASCADE,
    CONSTRAINT fk_csl_tag   FOREIGN KEY (coser_tag_id) REFERENCES tags (id) ON DELETE SET NULL,
    CONSTRAINT fk_csl_uid   FOREIGN KEY (create_uid) REFERENCES users (id)
) ENGINE = InnoDB COMMENT 'Coser专属返图分享链接';

-- snapshot=1 时固化命中的图片集合
CREATE TABLE share_link_images (
    link_id  INT UNSIGNED NOT NULL,
    image_id INT UNSIGNED NOT NULL,
    sort     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, image_id),
    KEY idx_image (image_id),
    CONSTRAINT fk_sli_link  FOREIGN KEY (link_id)  REFERENCES coser_share_links (id) ON DELETE CASCADE,
    CONSTRAINT fk_sli_image FOREIGN KEY (image_id) REFERENCES images (id) ON DELETE CASCADE
) ENGINE = InnoDB COMMENT '分享链接图片快照';

-- -----------------------------------------------------------------------------
-- 9. 网盘文件夹表
--    变更：新增 path 物化路径（V1.0 只有 parent_id，取整棵子树需递归查询）、
--          description、update_time；补索引
-- -----------------------------------------------------------------------------
CREATE TABLE folders (
    id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    parent_id   INT UNSIGNED NULL COMMENT '上级文件夹，顶级NULL',
    path        VARCHAR(500) NOT NULL DEFAULT '/' COMMENT '物化路径，如 /1/5/12/',
    depth       TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '层级，限制最大8层',
    name        VARCHAR(100) NOT NULL COMMENT '文件夹名称',
    description VARCHAR(500) NOT NULL DEFAULT '',
    visibility  ENUM('public','member','admin','private') NOT NULL DEFAULT 'member' COMMENT '不得宽于祖先链',
    create_uid  INT UNSIGNED NOT NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_parent_name (parent_id, name),
    KEY idx_path (path),
    KEY idx_parent (parent_id),
    KEY idx_visibility (visibility),
    KEY idx_create_uid (create_uid),
    CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_folders_uid    FOREIGN KEY (create_uid) REFERENCES users (id)
) ENGINE = InnoDB COMMENT '网盘树形目录';

-- folders 已建表，补上临时账号文件夹白名单的外键
ALTER TABLE temp_account_folders ADD CONSTRAINT fk_taf_folder
    FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- 10. 网盘文件表
--    变更：补外键、md5/size/upload_uid 索引、album 无关性保持独立模块
-- -----------------------------------------------------------------------------
CREATE TABLE files (
    id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    folder_id    INT UNSIGNED NOT NULL COMMENT '所属文件夹ID',
    filename     VARCHAR(255) NOT NULL COMMENT '文件原名（展示用）',
    storage_path VARCHAR(255) NOT NULL COMMENT '服务器存储路径（重命名后）',
    file_size    BIGINT UNSIGNED NOT NULL COMMENT '字节数',
    mime_type    VARCHAR(100) NOT NULL DEFAULT '' COMMENT '校验后的真实MIME',
    md5          CHAR(32) NOT NULL COMMENT '文件MD5，去重依据',
    preview_status TINYINT NOT NULL DEFAULT 0 COMMENT '0未生成 1已生成 2不支持 3生成失败',
    visibility   ENUM('public','member','admin','private') NOT NULL DEFAULT 'member',
    upload_uid   INT UNSIGNED NOT NULL COMMENT '归属人ID（临时账号上传时=其owner_uid）',
    upload_temp_id INT UNSIGNED NULL COMMENT '非NULL=临时账号上传，记录实际上传者',
    temp_account_id INT UNSIGNED NULL COMMENT '非NULL=该文件是某条返图工单的附件（PRD 6.2 后期前效果）',
    ref_stage      VARCHAR(8)   NULL COMMENT 'pre / post，非工单附件为 NULL',
    create_time  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_folder_vis (folder_id, visibility),
    KEY idx_upload_uid (upload_uid),
    KEY idx_md5 (md5),
    KEY idx_create_time (create_time),
    KEY idx_temp_ref (temp_account_id, ref_stage),
    CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_files_temp   FOREIGN KEY (upload_temp_id) REFERENCES temp_accounts (id) ON DELETE SET NULL
) ENGINE = InnoDB COMMENT '网盘文件';

ALTER TABLE files
    ADD CONSTRAINT fk_files_uid FOREIGN KEY (upload_uid) REFERENCES users (id);
ALTER TABLE images
    ADD CONSTRAINT fk_images_uid FOREIGN KEY (upload_uid) REFERENCES users (id);

-- -----------------------------------------------------------------------------
-- 11. 分片上传会话表（V1.0 缺失：5.3 断点续传 / 6 上传进度无落库位置）
-- -----------------------------------------------------------------------------
CREATE TABLE upload_sessions (
    id             INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    upload_id      VARCHAR(64) NOT NULL COMMENT '客户端会话UUID',
    resource_type  ENUM('image','file') NOT NULL,
    album_id       INT UNSIGNED NULL,
    folder_id      INT UNSIGNED NULL,
    filename       VARCHAR(255) NOT NULL,
    file_size      BIGINT UNSIGNED NOT NULL,
    chunk_size     INT UNSIGNED NOT NULL DEFAULT 5242880 COMMENT '分片大小，默认5MB',
    total_chunks   INT UNSIGNED NOT NULL DEFAULT 0,
    uploaded_chunks VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '已收分片下标，逗号分隔',
    md5_client     CHAR(32) NOT NULL DEFAULT '' COMMENT '客户端预算MD5，合并后校验',
    user_type      ENUM('user','temp') NOT NULL,
    uid            INT UNSIGNED NULL,
    temp_id        INT UNSIGNED NULL,
    status         TINYINT NOT NULL DEFAULT 0 COMMENT '0进行中 1已完成 2已放弃',
    create_time    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    expire_time    DATETIME NOT NULL COMMENT '超时丢弃，碎片由定时任务清理',
    UNIQUE KEY uk_upload_id (upload_id),
    KEY idx_uid (user_type, uid),
    KEY idx_expire (status, expire_time)
) ENGINE = InnoDB COMMENT '断点续传会话';

-- -----------------------------------------------------------------------------
-- 12. 游客留言表（V1.0 缺失：3.3 游客留言+审核无落库位置）
-- -----------------------------------------------------------------------------
CREATE TABLE guestbook_messages (
    id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    nickname    VARCHAR(50)  NOT NULL DEFAULT '' COMMENT '游客自称',
    contact     VARCHAR(100) NOT NULL DEFAULT '' COMMENT '联系方式，仅管理员可见',
    content     VARCHAR(1000) NOT NULL COMMENT '留言正文',
    album_id    INT UNSIGNED NULL COMMENT '关联相册，可空',
    status      TINYINT NOT NULL DEFAULT 0 COMMENT '0待审 1已通过 2已拒绝',
    audit_uid   INT UNSIGNED NULL COMMENT '审核人(L3/L4)',
    audit_time  DATETIME NULL,
    ip          VARCHAR(50) NOT NULL DEFAULT '',
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_status_time (status, create_time),
    KEY idx_album (album_id),
    CONSTRAINT fk_gb_album  FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE SET NULL,
    CONSTRAINT fk_gb_audit FOREIGN KEY (audit_uid) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB COMMENT '游客留言（先审后展示）';

-- -----------------------------------------------------------------------------
-- 13. 全站操作日志表
--     变更：V1.0 零索引，审计页按人/时间筛选必全表扫；现补 3 组索引 + detail/ua；
--     建议保留 180 天，由定时任务按 create_time 归档删除
--     设计说明：uid / temp_id / target_id 刻意不加外键——审计记录必须比业务数据
--     活得更久，用户被删、资源被删后日志仍需可查（同理见 upload_sessions）
-- -----------------------------------------------------------------------------
CREATE TABLE logs (
    id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_type   ENUM('user','temp','guest','system') NOT NULL COMMENT '操作主体类型',
    uid         INT UNSIGNED NULL COMMENT '正式用户ID',
    temp_id     INT UNSIGNED NULL COMMENT '临时账号ID',
    action      VARCHAR(50) NOT NULL COMMENT 'login/upload/download/delete/perm_change...',
    target_type ENUM('album','image','file','folder','tag','user','temp','site','link','message','crawler') NULL,
    target_id   INT UNSIGNED NULL,
    detail      VARCHAR(500) NOT NULL DEFAULT '' COMMENT '补充信息(JSON)，如变更前后权限',
    ip          VARCHAR(50) NOT NULL,
    ua          VARCHAR(255) NOT NULL DEFAULT '',
    result      TINYINT NOT NULL DEFAULT 1 COMMENT '1成功 0被拦截(用于安全分析)',
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_time (create_time),
    KEY idx_uid_time (user_type, uid, create_time),
    KEY idx_target (target_type, target_id),
    KEY idx_action_time (action, create_time)
) ENGINE = InnoDB COMMENT '操作与审计日志';

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- 14. 站外来源登记表（PRD D23 爬虫模块，2026-10-02 新增）
--     只登记外部链接与页面上的少量文本元数据，不落地任何抓取到的文件字节；
--     建表语句落在 FOREIGN_KEY_CHECKS 之后与 InitSchema 迁移的执行顺序一致，
--     单独 ALTER 即可补建，不影响已有 16 张表。
--     索引名带 crawler 前缀：SQLite 的索引名是库级唯一，同名会卡住 synchronize。
-- -----------------------------------------------------------------------------
CREATE TABLE crawler_links (
    id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    url         VARCHAR(1000) NOT NULL COMMENT '规范化后的站外地址(去 fragment 与跟踪参数)',
    url_hash    CHAR(64)      NOT NULL COMMENT '规范化地址的 sha256，去重键',
    title       VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '检索命中条目的标题',
    snippet     VARCHAR(500)  NOT NULL DEFAULT '' COMMENT '命中摘要，不存正文',
    domain      VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '注册域，如 weibo.com',
    platform    ENUM('weibo','bilibili','xiaohongshu','douyin','twitter','other') NOT NULL DEFAULT 'other',
    keyword     VARCHAR(100)  NOT NULL DEFAULT '' COMMENT '登记时命中的检索词',
    source      ENUM('search','manual') NOT NULL DEFAULT 'search' COMMENT '检索登记 / 手敲粘贴',
    status      TINYINT       NOT NULL DEFAULT 0 COMMENT '0待处理 1已记录 2已联系授权 3已投诉 4已忽略',
    note        VARCHAR(500)  NOT NULL DEFAULT '' COMMENT '跟进备注',
    create_uid  INT UNSIGNED NULL COMMENT '登记人(仅 L4)',
    audit_uid   INT UNSIGNED NULL COMMENT '最后一次改跟进状态的人',
    audit_time  DATETIME NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_crawler_url_hash (url_hash),
    KEY idx_crawler_status_time (status, create_time),
    KEY idx_crawler_platform (platform),
    CONSTRAINT fk_crawler_create FOREIGN KEY (create_uid) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_crawler_audit  FOREIGN KEY (audit_uid)  REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB COMMENT '站外来源登记（仅超管可见，不落地文件）';

-- =============================================================================
-- 初始化数据
-- =============================================================================

-- 超管账号：password 为 bcrypt(cost=12) 后的密文。
-- 首次部署后必须立即登录改密。占位密文对应初始密码 ChangeMe_2026
INSERT INTO users (username, password, nickname, level, space_quota, status)
VALUES ('admin', '$2b$12$PLACEHOLDER_REPLOY_BEFORE_PROD', '超级管理员', 4, 0, 1);

-- 站点默认配置
INSERT INTO site_settings (skey, sval, remark) VALUES
('upload.max_image_size',  '52428800',  '单张图片最大字节数(50MB)'),
('upload.max_file_size',   '2147483648','单个文件最大字节数(2GB)'),
('upload.image_extensions','[".jpg",".jpeg",".png",".webp",".heic",".tif",".tiff",".raw",".cr2",".nef",".arw"]','图片扩展名白名单，仍需校验二进制头'),
('upload.file_extensions', '[".jpg",".jpeg",".png",".webp",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".psd",".ai",".zip",".7z",".rar",".mp4",".mov",".preset",".xmp"]','文件扩展名白名单'),
('upload.blocked_extensions','[".exe",".bat",".cmd",".sh",".msi",".dll",".apk",".jar",".js",".vbs",".ps1",".scr"]','强制拒绝的可执行类型'),
('upload.chunk_size',      '5242880',   '断点续传分片大小'),
('upload.rate_limit',      '{"windowMs":60000,"max":30}','上传接口限流配置'),
('preview.max_width',      '2048',      '预览图长边像素'),
('preview.thumb_width',    '400',       '列表缩略图宽'),
('preview.quality',        '82',        '预览图JPEG质量'),
('watermark.enabled',      'false',     '全局水印开关'),
('watermark.text',         '皮克社工作室','水印文字'),
('watermark.position',     'bottomRight','水印位置'),
('watermark.opacity',      '0.35',      '水印不透明度'),
('storage.default_quota',  '10737418240','新成员默认配额(10GB)'),
('guest.comment_enabled',  'false',     '是否开放游客留言'),
('security.session_ttl',   '{"user":86400,"temp":3600}','JWT 有效期(秒)'),
('temp.default_quota',     '10737418240','临时账号默认配额(10GB)，L1/L2 创建的账号强制取此值(PRD 6.2)'),
('temp.max_days_for_l1_l2','7',         'L1/L2 创建临时账号的最长有效天数(PRD D9)'),
('task.overdue_notify_enabled','true',  '逾期未交付工单是否每日告警(PRD 13 章)');

-- 内置状态标签（status 类型不可由普通成员增删）
INSERT INTO tags (tag_type, tag_name) VALUES
('status','待修'), ('status','已修'), ('status','废弃');
