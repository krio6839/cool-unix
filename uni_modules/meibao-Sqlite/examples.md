# meibao-Sqlite 快速上手指南

## 安装

将 `meibao-Sqlite` 文件夹复制到项目的 `uni_modules` 目录下。

## 基础用法示例

### 1. 创建数据库工具类

建议创建一个数据库工具类，方便全局使用：

```typescript
// utils/DBUtils.uts
import { openDatabase, executeSql, selectSql, closeDatabase } from "@/uni_modules/meibao-Sqlite"

export class DBUtils {
  private static dbName = 'app_db'
  private static isOpened = false

  // 初始化数据库
  static init(): void {
    if (this.isOpened) {
      return
    }

    openDatabase({
      name: this.dbName,
      success: () => {
        this.isOpened = true
        console.log('数据库初始化成功')
        this.createTables()
      },
      fail: (err) => {
        console.error('数据库初始化失败:', err.errMsg)
      }
    })
  }

  // 创建表
  private static createTables(): void {
    // 用户表
    executeSql({
      name: this.dbName,
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        avatar TEXT,
        created_at TEXT
      )`,
      success: () => {
        console.log('用户表创建成功')
      }
    })

    // 设置表
    executeSql({
      name: this.dbName,
      sql: `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,
      success: () => {
        console.log('设置表创建成功')
      }
    })
  }

  // 获取数据库名称
  static getDBName(): string {
    return this.dbName
  }

  // 关闭数据库
  static close(): void {
    if (this.isOpened) {
      closeDatabase({
        name: this.dbName,
        success: () => {
          this.isOpened = false
          console.log('数据库已关闭')
        }
      })
    }
  }
}
```

### 2. 在 App.uvue 中初始化

```vue
<script setup lang="uts">
import { DBUtils } from "@/utils/DBUtils"

onLaunch(() => {
  // 初始化数据库
  DBUtils.init()
})

onExit(() => {
  // 退出时关闭数据库
  DBUtils.close()
})
</script>
```

### 3. 创建数据访问对象（DAO）

```typescript
// dao/UserDao.uts
import { executeSql, selectSql } from "@/uni_modules/meibao-Sqlite"
import { DBUtils } from "@/utils/DBUtils"

export type User = {
  id?: number
  username: string
  password: string
  nickname?: string
  avatar?: string
  created_at?: string
}

export class UserDao {
  private static tableName = 'users'
  private static dbName = DBUtils.getDBName()

  // 插入用户
  static insert(user: User, callback: (success: boolean, message?: string) => void): void {
    const now = new Date().toISOString()
    const sql = `
      INSERT INTO ${this.tableName} (username, password, nickname, avatar, created_at)
      VALUES ('${user.username}', '${user.password}', '${user.nickname || ''}', '${user.avatar || ''}', '${now}')
    `

    executeSql({
      name: this.dbName,
      sql: sql,
      success: () => {
        callback(true, '用户创建成功')
      },
      fail: (err) => {
        callback(false, err.errMsg)
      }
    })
  }

  // 根据用户名查询
  static findByUsername(username: string, callback: (user: User | null) => void): void {
    const sql = `SELECT id, username, password, nickname, avatar, created_at FROM ${this.tableName} WHERE username = '${username}'`

    selectSql({
      name: this.dbName,
      sql: sql,
      success: (res) => {
        if (res.rows.length > 0) {
          const row = res.rows[0]
          const user: User = {
            id: parseInt(row[0]),
            username: row[1],
            password: row[2],
            nickname: row[3],
            avatar: row[4],
            created_at: row[5]
          }
          callback(user)
        } else {
          callback(null)
        }
      },
      fail: () => {
        callback(null)
      }
    })
  }

  // 查询所有用户
  static findAll(callback: (users: User[]) => void): void {
    const sql = `SELECT id, username, nickname, avatar, created_at FROM ${this.tableName} ORDER BY id DESC`

    selectSql({
      name: this.dbName,
      sql: sql,
      success: (res) => {
        const users: User[] = []
        for (let i = 0; i < res.rows.length; i++) {
          const row = res.rows[i]
          users.push({
            id: parseInt(row[0]),
            username: row[1],
            nickname: row[2],
            avatar: row[3],
            created_at: row[4]
          })
        }
        callback(users)
      },
      fail: () => {
        callback([])
      }
    })
  }

  // 更新用户
  static update(id: number, user: Partial<User>, callback: (success: boolean) => void): void {
    const updates: string[] = []

    if (user.nickname !== undefined) {
      updates.push(`nickname = '${user.nickname}'`)
    }
    if (user.avatar !== undefined) {
      updates.push(`avatar = '${user.avatar}'`)
    }

    if (updates.length === 0) {
      callback(false)
      return
    }

    const sql = `UPDATE ${this.tableName} SET ${updates.join(', ')} WHERE id = ${id}`

    executeSql({
      name: this.dbName,
      sql: sql,
      success: () => {
        callback(true)
      },
      fail: () => {
        callback(false)
      }
    })
  }

  // 删除用户
  static delete(id: number, callback: (success: boolean) => void): void {
    const sql = `DELETE FROM ${this.tableName} WHERE id = ${id}`

    executeSql({
      name: this.dbName,
      sql: sql,
      success: () => {
        callback(true)
      },
      fail: () => {
        callback(false)
      }
    })
  }
}
```

### 4. 在页面中使用

```vue
<script setup lang="uts">
import { UserDao } from "@/dao/UserDao"
import { User } from "@/dao/UserDao"

// 查询所有用户
const loadUsers = () => {
  UserDao.findAll((users) => {
    console.log('用户列表:', users)
    // 更新UI显示
  })
}

// 添加用户
const addUser = () => {
  const user: User = {
    username: 'zhangsan',
    password: '123456',
    nickname: '张三'
  }

  UserDao.insert(user, (success, message) => {
    if (success) {
      console.log('添加成功')
      loadUsers()
    } else {
      console.error('添加失败:', message)
    }
  })
}

// 更新用户
const updateUser = (id: number) => {
  UserDao.update(id, { nickname: '张三三' }, (success) => {
    if (success) {
      console.log('更新成功')
      loadUsers()
    }
  })
}

// 删除用户
const deleteUser = (id: number) => {
  UserDao.delete(id, (success) => {
    if (success) {
      console.log('删除成功')
      loadUsers()
    }
  })
}
</script>
```

## 常见 SQL 模板

### 创建表

```typescript
const sql = `
  CREATE TABLE IF NOT EXISTS table_name (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    price REAL,
    is_active INTEGER DEFAULT 0,
    created_at TEXT
  )
`
```

### 插入数据

```typescript
// 单条插入
const sql = `INSERT INTO table_name (name, count) VALUES ('商品1', 100)`

// 使用变量
const name = '商品1'
const count = 100
const sql = `INSERT INTO table_name (name, count) VALUES ('${name}', ${count})`
```

### 更新数据

```typescript
// 简单更新
const sql = `UPDATE table_name SET count = 200 WHERE id = 1`

// 多字段更新
const sql = `UPDATE table_name SET name = '新名称', count = 300 WHERE id = 1`

// 条件更新
const sql = `UPDATE table_name SET count = count + 1 WHERE id = 1`
```

### 删除数据

```typescript
// 根据ID删除
const sql = `DELETE FROM table_name WHERE id = 1`

// 条件删除
const sql = `DELETE FROM table_name WHERE count < 10`

// 删除所有
const sql = `DELETE FROM table_name`
```

### 查询数据

```typescript
// 查询所有
const sql = `SELECT * FROM table_name`

// 指定列
const sql = `SELECT id, name FROM table_name`

// 条件查询
const sql = `SELECT * FROM table_name WHERE count > 100`

// 排序
const sql = `SELECT * FROM table_name ORDER BY created_at DESC`

// 限制数量
const sql = `SELECT * FROM table_name LIMIT 10`

// 分页
const sql = `SELECT * FROM table_name LIMIT 10 OFFSET 20`

// 模糊查询
const sql = `SELECT * FROM table_name WHERE name LIKE '%关键词%'`
```

## 数据类型映射

| SQLite 类型 | UTS 类型 | 说明 |
|------------|---------|------|
| INTEGER | number | 整数，自动转换为字符串 |
| REAL | number | 浮点数，自动转换为字符串 |
| TEXT | string | 字符串 |
| BLOB | string | 二进制数据（暂不支持） |

**注意：** 查询结果所有值都返回字符串类型，需要手动转换：
- 整数：`parseInt(row[0])`
- 浮点数：`parseFloat(row[0])`

## 最佳实践

1. **封装工具类**：创建 DBUtils 和 DAO 类，避免重复代码
2. **使用事务**：多个操作使用 transaction 保证一致性
3. **错误处理**：始终处理 fail 回调
4. **资源释放**：页面卸载时关闭数据库
5. **SQL 转义**：拼接 SQL 时对字符串进行转义
6. **类型转换**：查询结果记得转换数据类型

## 完整示例项目

参考 `pages/sqlite-test/index.uvue` 查看完整的使用示例。
