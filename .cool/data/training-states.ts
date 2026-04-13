import type { TrainingState, StatusPageState } from "../types";

// 三种状态的模拟数据
export const trainingStates: TrainingState[] = [
	// 超量恢复
	{
		key: "supercompensation",
		userInfo: {
			name: "张晓明",
			lastLoginTime: "2026.01.15"
		},
		healthStatus: {
			status: 82,
			sleep: 88,
			load: 55
		},
		boomGoText: "hi！现在是你的最佳训练窗口，建议进行高质量训练！如果不练，我都替你感觉亏！",
		energyPercentage: 88,
		healthCardValues: {
			heartRate: 64,
			restingHeartRate: 52,
			oxygen: 98,
			hrv: 62
		},
		details: {
			supercompensationTime: "次日 10:00 – 14:00",
			suggestion: "中高强度训练（阈值 / 间歇）",
			duration: "60–90分钟",
			target: "提升能力上限（耐力/阈值）"
		}
	},
	// 过度训练
	{
		key: "overtraining",
		userInfo: {
			name: "张晓明",
			lastLoginTime: "2026.01.15"
		},
		healthStatus: {
			status: 38,
			sleep: 72,
			load: 92,
			statusTrend: "down",
			loadTrend: "up"
		},
		boomGoText:
			"下午好！当前身体仍处在高负荷后的恢复阶段，继续训练不会带来有效提升，只会增加疲劳和损伤风险。建议今日仅进行低强度活动（如轻松走路/拉伸），务必保证睡眠 ≥ 8小时，并避免任何高心率训练刺激，好好休息，运动不是一朝一夕！",
		energyPercentage: 40,
		healthCardValues: {
			heartRate: 72,
			restingHeartRate: 68,
			oxygen: 97,
			hrv: 28
		},
		details: {
			supercompensationTime: "后天18:00–20:00"
		}
	},
	// 无效训练
	{
		key: "ineffective",
		userInfo: {
			name: "张晓明",
			lastLoginTime: "2026.01.15"
		},
		healthStatus: {
			status: 72,
			sleep: 78,
			load: 60
		},
		boomGoText:
			"hi！今天你完成了训练，但没有进入有效刺激区间。建议下一次训练中提高强度，当达到有效强度时我会提醒你。",
		energyPercentage: 70,
		healthCardValues: {
			heartRate: 78,
			restingHeartRate: 56,
			oxygen: 98,
			hrv: 52
		},
		details: {
			supercompensationTime: "次日 10:00 – 14:00"
		}
	}
];

// 健康状态页面的三种状态数据
export const statusPageStates: StatusPageState[] = [
	// 超量恢复
	{
		key: "supercompensation",
		totalStatus: 82,
		statusProgress: 82,
		healthItems: [
			{ label: "今日平均HRV", value: "60 ms" },
			{ label: "静息心率", value: "52 bpm" }
		],
		hrvData: [33, 36, 42, 48, 52, 56, 60, 63, 66, 58, 54, 52],
		readinessData: [42, 38, 45, 55, 65, 78, 85],
		totalEnergy: 85,
		energyProgress: 85,
		energyItems: [
			{ label: "总充能", value: 92 },
			{ label: "总耗能", value: 58 }
		],
		energyChartData: [72, 78, 83, 88, 85, 82, 80, 78, 75, 65, 68, 72],
		bodyEnergyChartData: [48, 42, 52, 60, 68, 76, 85],
		maxEnergy: 85,
		averageEnergyRange: "60%–65%",
		totalLoad: 55,
		loadProgress: 55,
		loadItems: [
			{ label: "平均负荷", value: 50 },
			{ label: "静息心率", value: 52 },
			{ label: "步数", value: 12800 },
			{ label: "卡路里", value: 2350 }
		],
		realtimeLoadData: [35, 32, 30, 33, 40, 45, 50, 55, 70, 75, 60, 48],
		loadZones: [
			{ label: "负荷过载", value: "8%｜2小时" },
			{ label: "注意负荷", value: "25%｜6小时" },
			{ label: "状态正常", value: "42%｜10小时" },
			{ label: "状态优秀", value: "17%｜4小时" }
		],
		loadTrendData: [88, 92, 80, 72, 65, 60, 55],
		loadTrendInfo: { max: 92, maxDay: "周二", min: 55, minDay: "周日", average: 73 },
		exerciseLoadData: [75, 85, 70, 60, 55, 50, 45],
		exerciseLoadTrendInfo: { max: 85, maxDay: "周二", min: 45, minDay: "周日", average: 63 },
		sleepPressureData: [62, 68, 60, 55, 48, 42, 38],
		sleepPressureTrendInfo: { max: 68, maxDay: "周二", min: 38, minDay: "周日", average: 53 },
		heartRateZoneData: [62, 58, 56, 60, 78, 110, 135, 172, 150, 120, 95],
		heartRateZoneItems: [
			{ zone: "Zone 0", percentage: 25 },
			{ zone: "Zone 1", percentage: 25 },
			{ zone: "Zone 2", percentage: 33 },
			{ zone: "Zone 3", percentage: 8 },
			{ zone: "Zone 4", percentage: 8 },
			{ zone: "Zone 5", percentage: 0 }
		]
	},
	// 过度训练
	{
		key: "overtraining",
		totalStatus: 38,
		statusProgress: 38,
		healthItems: [
			{ label: "今日平均HRV", value: "30 ms" },
			{ label: "静息心率", value: "69 bpm" }
		],
		hrvData: [25, 28, 26, 24, 27, 25, 26, 28, 27, 25, 24, 23],
		readinessData: [65, 60, 55, 50, 45, 40, 38],
		totalEnergy: 30,
		energyProgress: 30,
		energyItems: [
			{ label: "总充能", value: 62 },
			{ label: "总耗能", value: 88 }
		],
		energyChartData: [50, 52, 55, 53, 50, 46, 40, 34, 30, 32, 31, 30],
		bodyEnergyChartData: [72, 68, 63, 58, 50, 42, 30],
		maxEnergy: 72,
		averageEnergyRange: "40%–70%",
		totalLoad: 92,
		loadProgress: 92,
		loadItems: [
			{ label: "平均负荷", value: 85 },
			{ label: "静息心率", value: 68 },
			{ label: "步数", value: 28500 },
			{ label: "卡路里", value: 3200 }
		],
		realtimeLoadData: [48, 45, 43, 47, 55, 62, 68, 78, 85, 82, 75, 65],
		loadZones: [
			{ label: "压力过载", value: "25%｜6小时" },
			{ label: "注意压力", value: "33%｜8小时" },
			{ label: "状态正常", value: "33%｜8小时" },
			{ label: "状态优秀", value: "0%｜0小时" }
		],
		loadTrendData: [65, 70, 75, 82, 88, 90, 92],
		loadTrendInfo: { max: 92, maxDay: "周日", min: 65, minDay: "周一", average: 80 },
		exerciseLoadData: [50, 55, 60, 70, 78, 85, 90],
		exerciseLoadTrendInfo: { max: 90, maxDay: "周日", min: 50, minDay: "周一", average: 70 },
		sleepPressureData: [35, 38, 40, 43, 45, 48, 50],
		sleepPressureTrendInfo: { max: 50, maxDay: "周日", min: 35, minDay: "周一", average: 43 },
		heartRateZoneData: [62, 58, 56, 60, 78, 110, 135, 172, 150, 120, 95],
		heartRateZoneItems: [
			{ zone: "Zone 0", percentage: 10 },
			{ zone: "Zone 1", percentage: 15 },
			{ zone: "Zone 2", percentage: 20 },
			{ zone: "Zone 3", percentage: 20 },
			{ zone: "Zone 4", percentage: 20 },
			{ zone: "Zone 5", percentage: 15 }
		]
	},
	// 无效训练
	{
		key: "ineffective",
		totalStatus: 70,
		statusProgress: 72,
		healthItems: [
			{ label: "今日平均HRV", value: "51 ms" },
			{ label: "静息心率", value: "56 bpm" }
		],
		hrvData: [45, 48, 46, 44, 47, 45, 46, 48, 47, 45, 44, 43],
		readinessData: [60, 62, 65, 63, 60, 58, 56],
		totalEnergy: 62,
		energyProgress: 62,
		energyItems: [
			{ label: "总充能", value: 68 },
			{ label: "总耗能", value: 66 }
		],
		energyChartData: [65, 68, 70, 66, 63, 60, 61, 62],
		bodyEnergyChartData: [60, 62, 61, 63, 62, 64, 62],
		maxEnergy: 64,
		averageEnergyRange: "60%–64%",
		totalLoad: 60,
		loadProgress: 60,
		loadItems: [
			{ label: "平均负荷", value: 57 },
			{ label: "静息心率", value: 56 },
			{ label: "步数", value: 11200 },
			{ label: "卡路里", value: 2150 }
		],
		realtimeLoadData: [30, 28, 32, 45, 55, 60, 52, 42],
		loadZones: [
			{ label: "负荷过载", value: "0%｜0小时" },
			{ label: "注意负荷", value: "5%｜1.2小时" },
			{ label: "状态正常", value: "60%｜14.4小时" },
			{ label: "状态优秀", value: "35%｜8.4小时" }
		],
		loadTrendData: [58, 60, 61, 59, 60, 62, 60],
		loadTrendInfo: { max: 62, maxDay: "周六", min: 58, minDay: "周一", average: 60 },
		exerciseLoadData: [52, 55, 56, 54, 55, 57, 55],
		exerciseLoadTrendInfo: { max: 57, maxDay: "周六", min: 52, minDay: "周一", average: 55 },
		sleepPressureData: [32, 35, 33, 31, 34, 32, 33],
		sleepPressureTrendInfo: { max: 35, maxDay: "周二", min: 31, minDay: "周四", average: 33 },
		heartRateZoneData: [52, 50, 55, 95, 110, 128, 110, 75],
		heartRateZoneItems: [
			{ zone: "Zone 0", percentage: 30 },
			{ zone: "Zone 1", percentage: 20 },
			{ zone: "Zone 2", percentage: 30 },
			{ zone: "Zone 3", percentage: 20 },
			{ zone: "Zone 4", percentage: 0 },
			{ zone: "Zone 5", percentage: 0 }
		]
	}
];
