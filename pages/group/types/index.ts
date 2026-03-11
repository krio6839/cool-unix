// 团队相关类型定义
export type TeamMember = {
  id: string;
  name: string;
  avatar?: string;
  energy: number;
  riskIndex: number;
};

export type TeamGroup = {
  id: string;
  name: string;
  leader: string;
  memberCount: number;
  members: TeamMember[];
};

export type Team = {
  id: string;
  name: string;
  avatar?: string;
  memberCount: number;
  groups: TeamGroup[];
};