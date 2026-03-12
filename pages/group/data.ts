import type { Team, TeamGroup } from "./types";

// 团队数据存储
export const teamData: Team = {
	id: "1",
	name: "组织名称",
	avatar: "https://img.yzcdn.cn/vant/cat.jpeg",
	memberCount: 8657,
	groups: [
		{
			id: "101",
			name: "小组一",
			leader: "张晓明",
			memberCount: 865,
			members: [
				{ id: "1001", name: "张三", energy: 379, riskIndex: 95 },
				{ id: "1002", name: "李四", energy: 288, riskIndex: 15 },
				{ id: "1003", name: "王五", energy: 178, riskIndex: 58 }
			]
		},
		{
			id: "102",
			name: "小组二",
			leader: "张晓暗",
			memberCount: 379,
			members: [
				{ id: "2001", name: "赵六", energy: 456, riskIndex: 23 },
				{ id: "2002", name: "钱七", energy: 321, riskIndex: 78 }
			]
		},
		{
			id: "103",
			name: "小组三",
			leader: "张晓明",
			memberCount: 271,
			members: [
				{ id: "3001", name: "孙八", energy: 567, riskIndex: 45 },
				{ id: "3002", name: "周九", energy: 234, riskIndex: 67 }
			]
		}
	]
};

// 根据group id获取小组数据
export const getGroupById = (groupId: string): TeamGroup | null => {
	return teamData.groups.find((group) => group.id == groupId) ?? null;
};
