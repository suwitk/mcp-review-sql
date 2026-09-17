# Skill Prerequisites — Full-Stack Performance Trace Review

สิ่งที่ต้องมีก่อนเรียกใช้ skill นี้ได้จริง (ไม่ใช่แค่ตัวอย่าง/placeholder เหมือน report template ก่อนหน้า):

1. **Backend code** — เข้าถึง source code ฝั่ง backend/service ได้ (อ่านได้อย่างน้อย)
2. **Frontend code** — เข้าถึง source code ฝั่ง frontend ได้ (อ่านได้อย่างน้อย)
3. **MCP SQL Server (SQL Server Review MCP)** — ต่อเข้า database ได้โดยตรงแบบ read-only

ข้อ 1–2 ตรงไปตรงมา (อ่าน repo ได้ก็พอ) ส่วนข้อ 3 มีรายละเอียดที่ต้องอธิบายก่อน เพราะเป็นเครื่องมือเฉพาะที่ต้อง setup ฝั่ง database และมีขอบเขตความปลอดภัยที่ต้องเข้าใจก่อนใช้งาน — สรุปจาก spec ที่ `D:\noom\MCP\sqlserver-review-mcp`

---

## MCP SQL Server (SQL Server Review MCP) คืออะไร

เป็น MCP server แบบ **read-only** สำหรับ Microsoft SQL Server โดยเฉพาะ ทำหน้าที่เป็น "ตา" ให้ AI agent มองเข้าไปใน database ได้โดยตรงระหว่างตรวจ performance/architecture review — ไม่ใช่เครื่องมือดูแลระบบ (ไม่ใช่ DBA tool) และ **แก้ไขอะไรใน database ไม่ได้เลย** ไม่ว่าจะเป็นข้อมูล, schema, index, statistics, Query Store, หรือ server config

```
Browser Network → Frontend → Backend/API → Service/Repository
  → SQL / Stored Procedure → SQL Server → Execution Plan
  → Query Store → Tables / Indexes / Statistics
```

นี่คือช่วงสุดท้ายของ full-stack trace (Data Access → Database) ที่ diagram ก่อนหน้าวาดไว้ — MCP ตัวนี้คือสิ่งที่ทำให้ AI Agent "เห็น" ชั้นนี้ได้จริงแทนที่จะเดาจาก log

### ทำไมต้องมีชั้นนี้

Trace ปกติจะหยุดอยู่แค่ "Query ช้า" แต่ไม่รู้ว่าช้าเพราะอะไร — MCP ตัวนี้ตอบคำถามระดับ evidence ได้ตรง ๆ เช่น:

- ตารางนี้มี index อะไรบ้าง ใช้จริงไหม
- Query ตัวไหนใน Query Store ที่ตรงกับ SQL ใน repository
- Query นี้แพงเพราะอะไร (CPU / IO / locking / plan ไม่ดี)
- endpoint นี้ bound อยู่ที่ชั้นไหน (frontend, network, backend, หรือ database)
- มีหลักฐานอะไรรองรับข้อสรุปนั้น

แต่ **ไม่ตอบ** คำถามว่า "แก้ให้หน่อย" — MCP ให้แค่หลักฐาน/การวินิจฉัย การเปลี่ยนแปลงจริงยังต้องเป็นวิศวกร/DBA

---

## เครื่องมือที่มีให้ใช้ (19 tools)

| กลุ่ม | Tool | ใช้ทำอะไร |
|---|---|---|
| **Metadata** | `get_database_info` | ข้อมูล server/database, สถานะ Query Store |
| | `list_schemas` | รายชื่อ schema |
| | `list_tables` | รายชื่อตาราง + จำนวนแถวโดยประมาณ (ไม่ใช้ `COUNT(*)`) |
| | `describe_table` | โครงสร้างคอลัมน์ (ไม่ดึงข้อมูลจริง) |
| | `get_indexes` / `get_index_usage` | index ที่มี + สถิติการใช้งาน (ถ้าสิทธิ์อนุญาต) |
| | `get_foreign_keys` | ความสัมพันธ์ FK เข้า/ออก |
| | `describe_procedure` / `get_procedure_definition` | พารามิเตอร์ + source ของ stored procedure |
| | `get_database_files` | ขนาดไฟล์ data/log, การตั้งค่า growth |
| | `get_table_stats` | อายุ/ความ stale ของ statistics |
| **Query analysis** | `execute_select` *(ปิดไว้โดย default)* | รัน `SELECT` เดียวแบบมี guard |
| | `get_estimated_plan` *(ปิดไว้โดย default)* | ดู estimated execution plan โดยไม่ต้องรันจริง |
| | `query_store_top_queries` | query ที่แพงสุดจาก Query Store (by duration/cpu/logical_reads/executions) |
| | `query_store_query` | plan + ประวัติการรันของ query_id หนึ่งตัว |
| **Instance-level** *(ต้องสิทธิ์เพิ่ม)* | `get_wait_stats` | wait statistics ระดับ instance |
| | `get_missing_index_stats` | ข้อเสนอ index ที่ขาด (advisory เท่านั้น) |
| | `get_io_stats` | สถิติ IO ต่อไฟล์ |
| | `get_blocking_summary` | สรุป session ที่ถูก block (ดูอย่างเดียว ไม่ `KILL`) |
| | `get_active_expensive_queries` | query ที่กำลังรันอยู่ตอนนี้ |

ถ้าสิทธิ์/ฟีเจอร์ (เช่น Query Store) ไม่พร้อม แต่ละ tool จะตอบ error ที่ชัดเจน (`FEATURE_UNAVAILABLE`, `PERMISSION_DENIED`) แทนที่จะ crash — tool อื่นยังใช้งานได้ตามปกติ

---

## ความปลอดภัย — ทำไมถึง "แก้ database ไม่ได้จริง"

Defense in depth 5 ชั้น แต่ชั้นที่เป็นตัวบังคับจริงคือชั้นที่ 4:

```
AI Agent
  → ตรวจ input (zod)
  → SQL guard (tokenizer แยก keyword อันตราย)
  → timeout / จำกัดจำนวนแถวที่ตอบกลับ
  → SQL Server account แบบ read-only  ← ตัวบังคับจริง
  → สิทธิ์ระดับ SQL Server
```

- Account ที่ใช้ต่อ (`mcp_code_review`) **ไม่มีสิทธิ์เขียนในระดับ database เลย** — ต่อให้ SQL guard หลุด ก็เขียนไม่ได้อยู่ดี เพราะ account เองทำไม่ได้ทางกายภาพ
- ไม่มีการให้สิทธิ์ `sysadmin`, `db_owner`, `db_ddladmin`, `db_datawriter` หรือ `EXECUTE` แบบกว้าง ๆ
- `execute_select` / `get_estimated_plan` (2 tool เดียวที่รับ SQL ที่ผู้เรียกพิมพ์เอง) **ปิดไว้โดย default** ต้องเปิดผ่าน env `SQLSERVER_ENABLE_AD_HOC_SQL=true` เท่านั้น
- มี column-based redaction (`MCP_REDACT_COLUMNS`) แทนค่าคอลัมน์อ่อนไหว (password, token, ssn, credit_card, api_key ฯลฯ) ด้วย `***REDACTED***`
- ทุกการเรียก tool ถูก audit-log เป็น structured JSON (ไม่มี query text/ข้อมูลแถวหลุดไปในเน็ต แค่ fingerprint)

---

## สิ่งที่ต้องเตรียมก่อนต่อ MCP นี้เข้ากับ skill

| # | สิ่งที่ต้องมี | หมายเหตุ |
|---|---|---|
| 1 | SQL Server instance ที่จะรีวิว | on-prem / IaaS / Azure SQL Database ก็ได้ |
| 2 | Account แบบ read-only ชื่อ `mcp_code_review` | สร้างโดยรัน `sql/create-review-user.sql` (ต้องเป็น DBA รัน) แล้ว verify ด้วย `sql/verify-permissions.sql` |
| 3 | ตัดสินใจว่าจะให้สิทธิ์ระดับ instance (`VIEW SERVER STATE`) ไหม | ถ้าไม่ให้ → wait stats / missing-index / IO stats / blocking / active-queries จะใช้ไม่ได้ (tool อื่นใช้ได้ปกติ) ถ้าให้ → เห็น query ของ**ทั้ง instance** ไม่ใช่แค่ database เดียว ต้องพิจารณาเรื่อง data exposure ให้ดี |
| 4 | เปิด Query Store บน database เป้าหมาย | ต้องเปิดเองผ่าน DBA (`ALTER DATABASE ... SET QUERY_STORE = ON`) — Azure SQL เปิดให้ default อยู่แล้ว |
| 5 | ตั้งค่า `.env` (host, database, credential, timeout, row cap ฯลฯ) | อ้างอิง `.env.example` ในโปรเจกต์ |
| 6 | ตัดสินใจเรื่อง `execute_select` / `get_estimated_plan` | แนะนำ**ปิดไว้ก่อน**จนกว่า account จะ lock-down เรียบร้อย — tool อื่นในตารางด้านบนใช้ query ที่โค้ดเขียนตายตัวอยู่แล้ว ไม่ต้องเปิดก็ทำงานได้ |
| 7 | แนะนำต่อกับ staging/replica ก่อน | ไม่ใช่ production customer data โดยตรง ถ้าเลี่ยงได้ |

---

## Backend code / Frontend code (ข้อ 1–2)

สองข้อนี้ไม่มี spec พิเศษเหมือน MCP — แค่ให้ AI Agent เข้าถึง source code ได้ (repo access / IDE read access) เพื่อ:

- **Backend code** — ดู business logic, การเรียก query/ORM, controller/service layer จริง เทียบกับสิ่งที่ MCP เห็นใน database
- **Frontend code** — ดู flow การเรียก API, การจัดการ state/render ฝั่ง client เทียบกับสิ่งที่เห็นใน network/console

ทั้งสองข้อนี้เป็น "หลักฐานฝั่งโค้ด" ที่ต้องใช้คู่กับหลักฐานฝั่ง database จาก MCP เพื่อสรุป root cause ให้ครบทุกชั้นตาม trace เดิม (client → network → application → data access → database)

---

*ไฟล์นี้เป็นเอกสารอธิบาย prerequisite สำหรับใช้ประกอบตอนเขียน skill จริงต่อไป ยังไม่ใช่ตัว skill*
