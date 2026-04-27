# meibao-Sqlite

UniApp X SQLite 数据库插件，支持 Android 平台原生 SQLite 操作。

## 功能特性

- ✅ 打开/创建数据库
- ✅ 执行 SQL 语句（CREATE, INSERT, UPDATE, DELETE）
- ✅ 查询数据（SELECT）
- ✅ 事务支持
- ✅ 关闭数据库
- ✅ 删除数据库
- ✅ 内存管理优化

## 平台支持

- uni-app x: Android (App)

## 安装

将 `meibao-Sqlite` 文件夹放置在项目的 `uni_modules` 目录下。

## API 文档

### 1. openDatabase

打开或创建数据库。

```typescript
import { openDatabase } from "@/uni_modules/meibao-Sqlite"

openDatabase({
  name: 'mydb',  // 数据库名称（必填）
  success: (res) => {
    console.log('数据库打开成功', res.name)
  },
  fail: (err) => {
    console.error('数据库打开失败', err.errMsg)
  }
})
```

**注意：** 数据库文件会存储在 `/data/data/<package_name>/databases/` 目录下。

### 2. executeSql

执行 SQL 语句（CREATE, INSERT, UPDATE, DELETE 等）。

```typescript
import { executeSql } from "@/uni_modules/meibao-Sqlite"

// 创建表
executeSql({
  name: 'mydb',
  sql: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)',
  success: () => {
    console.log('表创建成功')
  }
})

// 插入数据（手动拼接 SQL）
executeSql({
  name: 'mydb',
  sql: "INSERT INTO users (name, age) VALUES ('张三', 25)",
  success: (res) => {
    console.log('插入成功，影响行数:', res.rowsAffected)
  }
})

// 使用变量的插入
const userName = '李四'
const userAge = 30
executeSql({
  name: 'mydb',
  sql: `INSERT INTO users (name, age) VALUES ('${userName}', ${userAge})`,
  success: (res) => {
    console.log('插入成功')
  }
})

// 更新数据
executeSql({
  name: 'mydb',
  sql: "UPDATE users SET age = 26 WHERE name = '张三'",
  success: (res) => {
    console.log('更新成功，影响行数:', res.rowsAffected)
  }
})

// 删除数据
executeSql({
  name: 'mydb',
  sql: 'DELETE FROM users WHERE age < 20',
  success: (res) => {
    console.log('删除成功，影响行数:', res.rowsAffected)
  }
})
```

**注意：** 当前版本不支持参数绑定（args 参数），请手动拼接 SQL 字符串。请注意对字符串值进行转义以防止 SQL 注入。

### 3. selectSql

查询数据（SELECT）。返回二维字符串数组。

```typescript
import { selectSql } from "@/uni_modules/meibao-Sqlite"

// 查询所有数据
selectSql({
  name: 'mydb',
  sql: 'SELECT id, name, age FROM users ORDER BY id DESC LIMIT 10',
  success: (res) => {
    console.log('查询到', res.rowsAffected, '条记录')

    // 遍历结果（返回二维字符串数组）
    for (let i = 0; i < res.rows.length; i++) {
      const row = res.rows[i]
      // row 是字符串数组，按查询列的顺序访问
      // 例如：SELECT id, name, age 则 row[0]=id, row[1]=name, row[2]=age
      const id = row[0]
      const name = row[1]
      const age = row[2]
      console.log('ID:', id, '姓名:', name, '年龄:', age)
    }
  }
})

// 带条件的查询（手动拼接条件）
const minAge = 20
selectSql({
  name: 'mydb',
  sql: `SELECT * FROM users WHERE age > ${minAge}`,
  success: (res) => {
    console.log('查询到', res.rowsAffected, '条记录')
    for (let i = 0; i < res.rows.length; i++) {
      const row = res.rows[i]
      console.log(row)
    }
  }
})
```

**返回格式：** `res.rows` 是 `Array<Array<string>>` 类型（二维字符串数组）：
- 第一层数组：每一行数据
- 第二层数组：该行的列值（字符串类型）
- 访问方式：`res.rows[行索引][列索引]`

### 4. transaction

事务操作，保证数据一致性。

```typescript
import { transaction } from "@/uni_modules/meibao-Sqlite"

transaction({
  name: 'mydb',
  operation: (tx) => {
    // 在事务中执行多个 SQL（手动拼接）
    tx.executeSql("INSERT INTO users (name, age) VALUES ('李四', 30)")
    tx.executeSql("UPDATE users SET age = 31 WHERE name = '李四'")
    tx.executeSql("INSERT INTO logs (message) VALUES ('事务操作')")
  },
  success: () => {
    console.log('事务执行成功，所有数据已提交')
  },
  fail: (err) => {
    console.error('事务执行失败', err.errMsg)
    // 事务失败会自动回滚
  }
})
```

**注意：** 事务中如果任何一条 SQL 执行失败，整个事务会自动回滚。

### 5. closeDatabase

关闭数据库。

```typescript
import { closeDatabase } from "@/uni_modules/meibao-Sqlite"

closeDatabase({
  name: 'mydb',
  success: () => {
    console.log('数据库关闭成功')
  },
  fail: (err) => {
    console.error('数据库关闭失败', err.errMsg)
  }
})
```

### 6. deleteDatabase

删除数据库文件。

```typescript
import { deleteDatabase } from "@/uni_modules/meibao-Sqlite"

deleteDatabase({
  name: 'mydb',
  success: () => {
    console.log('数据库删除成功')
  },
  fail: (err) => {
    console.error('数据库删除失败', err.errMsg)
  }
})
```

## 完整使用示例

```typescript
// 导入插件
import { openDatabase, executeSql, selectSql, closeDatabase } from "@/uni_modules/meibao-Sqlite"

// 1. 打开数据库
openDatabase({
  name: 'testdb',
  success: () => {
    console.log('数据库打开成功')

    // 2. 创建表
    executeSql({
      name: 'testdb',
      sql: `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL,
        stock INTEGER
      )`,
      success: () => {
        console.log('表创建成功')

        // 3. 插入数据
        executeSql({
          name: 'testdb',
          sql: "INSERT INTO products (name, price, stock) VALUES ('iPhone 15', 5999.00, 100)",
          success: () => {
            console.log('数据插入成功')

            // 4. 查询数据
            selectSql({
              name: 'testdb',
              sql: 'SELECT id, name, price, stock FROM products WHERE price > 5000',
              success: (res) => {
                console.log('查询结果:', res.rows)

                // 遍历查询结果
                for (let i = 0; i < res.rows.length; i++) {
                  const row = res.rows[i]
                  const id = row[0]
                  const name = row[1]
                  const price = row[2]
                  const stock = row[3]
                  console.log(`商品: ${name}, 价格: ${price}, 库存: ${stock}`)
                }

                // 5. 关闭数据库
                closeDatabase({
                  name: 'testdb',
                  success: () => {
                    console.log('数据库关闭成功')
                  }
                })
              }
            })
          }
        })
      }
    })
  },
  fail: (err) => {
    console.error('数据库操作失败:', err.errMsg)
  }
})
```

## 页面生命周期最佳实践

为防止内存泄漏，建议在页面卸载时关闭数据库：

```vue
<script setup lang="uts">
import { openDatabase, executeSql, selectSql, closeDatabase } from "@/uni_modules/meibao-Sqlite"

const DB_NAME = 'mydb'

// 页面加载
onReady(() => {
  // 打开数据库
  openDatabase({
    name: DB_NAME,
    success: () => {
      console.log('数据库已打开')
    }
  })
})

// 页面卸载时关闭数据库
onUnload(() => {
  closeDatabase({
    name: DB_NAME,
    success: () => {
      console.log('页面卸载，数据库已关闭')
    },
    fail: () => {
      // 如果数据库未打开，忽略错误
    }
  })
})
</script>
```

## 错误码说明

| 错误码 | 说明 |
|--------|------|
| 9000001 | 数据库未打开 |
| 9000002 | 数据库已存在 |
| 9000003 | 数据库不存在 |
| 9000004 | SQL执行失败 |
| 9000005 | 参数错误（包括使用了暂不支持的功能） |
| 9000006 | 数据库关闭失败 |
| 9000007 | 数据库删除失败 |
| 9000008 | 事务执行失败 |
| 9000009 | 其他错误 |

## 注意事项

1. **数据库操作顺序**：使用数据库前必须先调用 `openDatabase` 打开数据库
2. **避免重复打开**：同一个数据库只能打开一次，重复打开会返回错误（9000002）
3. **关闭数据库**：使用完毕后建议调用 `closeDatabase` 关闭数据库，特别是在页面卸载时
4. **参数绑定**：当前版本**不支持参数绑定**（args 参数），请手动拼接 SQL 字符串
5. **SQL 注入防护**：手动拼接 SQL 时，请注意对字符串值进行转义，防止 SQL 注入攻击
6. **查询结果格式**：`selectSql` 返回的是二维字符串数组 `Array<Array<string>>`，按列索引访问
7. **事务回滚**：事务操作中如果任何一条 SQL 失败，整个事务会自动回滚
8. **数据库路径**：数据库存储在 Android 应用的私有目录，无需指定路径

## 常见问题

### Q: 为什么不支持参数绑定？

A: 当前版本的 UTS 与 Kotlin/Java 类型系统存在兼容性问题，导致参数绑定功能暂时无法实现。我们正在寻找解决方案，未来版本会支持。目前请使用手动拼接 SQL 的方式。

### Q: 如何防止 SQL 注入？

A: 在手动拼接 SQL 时，对字符串值进行转义：

```typescript
// 简单的转义函数
function escapeString(str: string): string {
  return str.replace(/'/g, "''")
}

const userName = escapeString(userInput) // 转义单引号
executeSql({
  name: 'mydb',
  sql: `INSERT INTO users (name) VALUES ('${userName}')`
})
```

### Q: 查询结果为什么是字符串数组而不是对象？

A: 为了确保类型兼容性和简化实现，当前版本返回二维字符串数组。未来版本可能会改进返回格式。

### Q: 如何访问查询结果中的列？

A: 使用列索引（从 0 开始）：

```typescript
// SQL: SELECT id, name, age FROM users
// 列索引: 0=id, 1=name, 2=age

const row = res.rows[0] // 第一行
const id = row[0]       // id 列
const name = row[1]     // name 列
const age = row[2]      // age 列
```

## 版本历史

### v1.0.0 (2025-02-06)
- ✅ 支持打开/创建数据库
- ✅ 支持执行 SQL 语句
- ✅ 支持查询数据（返回二维字符串数组）
- ✅ 支持事务操作
- ✅ 支持关闭/删除数据库
- ⚠️ 暂不支持参数绑定，需手动拼接 SQL

## 开发文档

- [UTS 语法](https://uniapp.dcloud.net.cn/tutorial/syntax-uts.html)
- [UTS API插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)
- [Hello UTS](https://gitcode.net/dcloud/hello-uts)
- [Android SQLiteDatabase](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase)

## 许可证

MIT License
