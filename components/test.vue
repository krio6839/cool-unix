<template>
	<view class="chartBox">
		<!-- 睡眠统计信息 -->
		<view class="sleep_stats">
			<view class="stat_item" v-for="(status, index) in status" :key="index">
				<view class="color_dot" :style="{ 'background-color': colors[index] }"></view>
				<text>{{ status }}</text>
				<text class="time">{{ calculateDuration(index) }}</text>
			</view>
		</view>

		<!-- Canvas图表 -->
		<view class="chart-container" style="position: relative" @tap="onCanvasTap">
			<canvas style="width: 100%; height: 150px" canvas-id="canvas" id="canvas"></canvas>
			<!-- 添加位置指示器 -->
			<view
				v-if="currentSegment"
				class="position-indicator"
				:style="{
					left: currentSegment.rect.x + 'px',
					width: currentSegment.rect.w + 'px',
					backgroundColor: getIndicatorColor(currentSegment.state)
				}"
			>
				<view
					class="indicator-info"
					:style="{
						backgroundColor: colors[currentSegment.state]
					}"
				>
					<text class="time_text">{{ formatTime(currentSegment.startTime) }} </text>
					<text class="time_text">|</text>
					<text class="time_text">{{ formatTime(currentSegment.endTime) }}</text>
					<text class="state_text">{{ status[currentSegment.state] }}</text>
				</view>
			</view>
		</view>
	</view>
</template>

<script>
export default {
	data() {
		return {
			sleepData: [
				{
					startTime: "2024-09-18 23:35:42",
					endTime: "2024-09-18 23:41:43",
					startTimestamp: 1726673742000,
					endTimestamp: 1726674103000,
					state: 2
				},
				{
					startTime: "2024-09-18 23:41:43",
					endTime: "2024-09-18 23:44:43",
					startTimestamp: 1726674103000,
					endTimestamp: 1726674283000,
					state: 1
				},
				{
					startTime: "2024-09-18 23:44:43",
					endTime: "2024-09-18 23:48:43",
					startTimestamp: 1726674283000,
					endTimestamp: 1726674523000,
					state: 0
				},
				{
					startTime: "2024-09-18 23:48:43",
					endTime: "2024-09-18 23:53:43",
					startTimestamp: 1726674523000,
					endTimestamp: 1726674823000,
					state: 3
				},
				{
					startTime: "2024-09-18 23:53:43",
					endTime: "2024-09-18 23:59:43",
					startTimestamp: 1726674823000,
					endTimestamp: 1726675183000,
					state: 1
				},
				{
					startTime: "2024-09-19 01:17:42",
					endTime: "2024-09-19 01:27:42",
					startTimestamp: 1726679862000,
					endTimestamp: 1726680462000,
					state: 2
				}
			],
			colors: ["#ffb908", "#ff9b0e", "#df6aff", "#8307ff"],
			status: ["清醒", "REM", "浅睡", "深睡"],
			touchValue: {},
			width: 0,
			height: 0,
			radius: 5,
			_lastDrawData: null,
			isDrawing: false,
			canvasContext: null,
			currentSegment: null
		};
	},

	async mounted() {
		try {
			await this.getWidthAndHeight();
			this.canvasContext = uni.createCanvasContext("canvas", this);
			this.init();
		} catch (error) {
			console.error("Canvas初始化失败:", error);
		}
	},

	methods: {
		getWidthAndHeight() {
			return new Promise((resolve, reject) => {
				const query = uni.createSelectorQuery().in(this);
				query
					.select("#canvas")
					.boundingClientRect((result) => {
						if (result) {
							this.width = result.width || 300;
							this.height = result.height || 150;

							if (this.width < 100 || this.height < 100) {
								console.warn("Canvas尺寸可能不合理，使用默认值");
								this.width = Math.max(this.width, 300);
								this.height = Math.max(this.height, 150);
							}
							resolve(true);
						} else {
							reject(new Error("获取Canvas尺寸失败"));
						}
					})
					.exec();
			});
		},

		init() {
			let yValue = [this.height - 110, this.height - 80, this.height - 50, this.height - 20];
			let xValue = 0;

			// 计算每个区间的原始宽度
			let originalWidths = this.sleepData.map((item) => {
				return item.endTimestamp - item.startTimestamp;
			});

			// 计算总的原始宽度
			let totalOriginalWidth = originalWidths.reduce((sum, width) => sum + width, 0);

			// 计算缩放比例（留出一些边距）
			let availableWidth = this.width * 0.95;
			let scaleRatio = availableWidth / totalOriginalWidth;

			// 计算每个区间的矩形参数
			for (let index = 0; index < this.sleepData.length; index++) {
				let item = this.sleepData[index];
				let yHeight = this.height * 0.13;

				let xWidth = Math.max(
					3,
					Math.floor((item.endTimestamp - item.startTimestamp) * scaleRatio)
				);
				let state = item.state;

				item.rect = {
					x: xValue,
					y: yValue[state],
					w: xWidth,
					h: yHeight
				};

				if (index < this.sleepData.length - 1) {
					let nextState = this.sleepData[index + 1].state;
					item.line = {
						x1: xValue + xWidth,
						y1:
							yValue[state] +
							(state > nextState ? yHeight - this.radius : this.radius),
						x2: xValue + xWidth,
						y2:
							yValue[nextState] +
							(state > nextState ? this.radius : yHeight - this.radius)
					};
				}

				xValue += xWidth;
			}

			// 处理圆角和连接线
			for (let index = 0; index < this.sleepData.length; index++) {
				let item = this.sleepData[index];
				let upOne = index > 0 ? this.sleepData[index - 1] : null;
				let nextOne = index < this.sleepData.length - 1 ? this.sleepData[index + 1] : null;

				item.left = upOne ? upOne.state < item.state : false;
				item.right = nextOne ? item.state > nextOne.state : false;
			}

			this.draft();
		},

		draft() {
			if (this.isDrawing) return;
			this.isDrawing = true;

			try {
				const currentData = JSON.stringify(this.sleepData);
				if (this._lastDrawData === currentData && !this.touchValue.touchX) {
					this.isDrawing = false;
					return;
				}
				this._lastDrawData = currentData;

				const context = this.canvasContext;
				if (!context) {
					throw new Error("Canvas context未初始化");
				}

				context.clearRect(0, 0, this.width, this.height);

				const gradientStartY = Math.max(0, this.height - 110);
				const gradientEndY = Math.max(0, this.height - 20);
				const gg = context.createLinearGradient(0, gradientStartY, 0, gradientEndY);

				try {
					gg.addColorStop(0, this.colors[0]);
					gg.addColorStop(0.33, this.colors[1]);
					gg.addColorStop(0.66, this.colors[2]);
					gg.addColorStop(1, this.colors[3]);
				} catch (error) {
					console.error("渐变设置失败:", error);
				}

				context.setLineWidth(1);
				context.setStrokeStyle(gg);
				context.setFillStyle(gg);

				this.drawSleepData(context);

				context.draw(true, () => {
					this.isDrawing = false;
				});
			} catch (error) {
				console.error("绘制失败:", error);
				this.isDrawing = false;
			}
		},

		drawSleepData(context) {
			for (let index = 0; index < this.sleepData.length; index++) {
				const item = this.sleepData[index];
				if (!item?.rect) continue;

				context.beginPath();
				this.drawRectangle(
					context,
					item.rect.x,
					item.rect.y,
					item.rect.w,
					item.rect.h,
					item.left,
					item.right
				);
				context.fill();

				if (index < this.sleepData.length - 1 && item.line) {
					context.beginPath();
					context.moveTo(item.line.x1, item.line.y1);
					context.lineTo(item.line.x2, item.line.y2);
					context.stroke();
				}
			}

			if (this.touchValue?.touchX) {
				const gline = context.createLinearGradient(0, 0, 0, this.height);
				gline.addColorStop(0, "rgba(241,244,245,0)");
				gline.addColorStop(0.5, "rgba(241,244,245,1)");
				gline.addColorStop(1, "rgba(241,244,245,0)");

				context.setStrokeStyle(gline);
				context.setFillStyle(gline);
				context.fillRect(this.touchValue.touchX, 0, 0.5, this.height);
				context.fill();
			}
		},

		drawRectangle(context, x, y, width, height, left, right) {
			let rset = this.radius;
			if (width < this.radius * 2) {
				rset = width / 2;
			}

			let lr = left ? -1 * rset : rset;
			let rr = right ? -1 * rset : rset;

			let arr = [];
			arr.push([x + rset, y + lr, Math.PI, left ? Math.PI / 2 : (Math.PI * 3) / 2]);
			arr.push([x + width - rset, y]);
			arr.push([x + width - rset, y + rr, right ? Math.PI / 2 : (Math.PI * 3) / 2, 0]);
			arr.push([x + width, y + height + rr]);
			arr.push([
				x + width - rset,
				y + height + rr,
				0,
				right ? Math.PI / 2 : (Math.PI * 3) / 2
			]);
			arr.push([x + rset, y + height]);
			arr.push([x + rset, y + height + lr, left ? Math.PI / 2 : (Math.PI * 3) / 2, Math.PI]);
			arr.push([x, y + rr]);

			context.beginPath();

			context.arc(arr[0][0], arr[0][1], rset, arr[0][2], arr[0][3], left);
			context.lineTo(arr[1][0], arr[1][1]);
			context.arc(arr[2][0], arr[2][1], rset, arr[2][2], arr[2][3], right);
			context.lineTo(arr[3][0], arr[3][1]);
			context.arc(arr[4][0], arr[4][1], rset, arr[4][2], arr[4][3], !right);
			context.lineTo(arr[5][0], arr[5][1]);
			context.arc(arr[6][0], arr[6][1], rset, arr[6][2], arr[6][3], !left);
			context.lineTo(arr[7][0], arr[7][1]);

			context.closePath();
		},

		calculateDuration(state) {
			const totalDuration = this.sleepData.reduce((acc, curr) => {
				if (curr.state === state) {
					return acc + (curr.endTimestamp - curr.startTimestamp);
				}
				return acc;
			}, 0);

			const hours = Math.floor(totalDuration / (1000 * 60 * 60));
			const minutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

			return `${hours}h${minutes}m`;
		},

		onCanvasTap(e) {
			if (!this.sleepData.length) return;

			// 获取点击位置相对于 canvas 的 x 坐标
			const touchX = e.touches[0].clientX - e.currentTarget.offsetLeft;

			// 查找当前位置对应的睡眠段
			let found = false;
			this.sleepData.forEach((item) => {
				if (touchX >= item.rect.x && touchX <= item.rect.x + item.rect.w && !found) {
					found = true;
					this.currentSegment = item;
					this.touchValue = {
						startTime: this.formatTime(item.startTime),
						endTime: this.formatTime(item.endTime),
						sleepState: item.state,
						sleepStateText: this.status[item.state],
						touchX: touchX
					};
				}
			});

			if (!found) {
				this.currentSegment = null;
			}

			this.draft(); // 重绘以显示指示线
		},

		handleCanvasTouch(touchX) {
			if (!this.sleepData.length) return;

			// 查找当前位置对应的睡眠段
			let found = false;
			this.sleepData.forEach((item) => {
				if (touchX >= item.rect.x && touchX <= item.rect.x + item.rect.w && !found) {
					found = true;
					this.currentSegment = item;
					this.touchValue = {
						startTime: this.formatTime(item.startTime),
						endTime: this.formatTime(item.endTime),
						sleepState: item.state,
						sleepStateText: this.status[item.state],
						touchX: touchX
					};
				}
			});

			if (!found) {
				this.currentSegment = null;
			}

			this.draft();
		},

		formatTime(timeString) {
			const date = new Date(timeString);
			const hours = date.getHours().toString().padStart(2, "0");
			const minutes = date.getMinutes().toString().padStart(2, "0");
			return `${hours}:${minutes}`;
		},

		// 获取指示器颜色
		getIndicatorColor(state) {
			// 将16进制颜色转换为rgba格式，添加0.3的透明度
			const hexColor = this.colors[state];
			const r = parseInt(hexColor.slice(1, 3), 16);
			const g = parseInt(hexColor.slice(3, 5), 16);
			const b = parseInt(hexColor.slice(5, 7), 16);
			return `rgba(${r}, ${g}, ${b}, 0.3)`;
		}
	}
};
</script>

<style>
.chartBox {
	background-color: #ffffff;
	border-radius: 16rpx;
	box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
	padding: 30rpx;
	margin: 20rpx;
}

.sleep_stats {
	display: flex;
	justify-content: space-around;
	margin-bottom: 20rpx;
	flex-wrap: wrap;
}

.stat_item {
	display: flex;
	align-items: center;
	margin: 10rpx 20rpx;
}

.color_dot {
	width: 12rpx;
	height: 12rpx;
	border-radius: 50%;
	margin-right: 8rpx;
}

.time {
	font-size: 24rpx;
	color: #666;
	margin-left: 8rpx;
}

.sleep_info {
	display: flex;
	justify-content: center;
	margin: 20rpx 0;
}

.info_box {
	padding: 12rpx 24rpx;
	border-radius: 30rpx;
	display: flex;
	flex-direction: column;
	align-items: center;
}

.time_text {
	color: #ffffff;
	font-size: 28rpx;
	font-weight: bold;
}

.state_text {
	color: #ffffff;
	font-size: 24rpx;
	margin-top: 4rpx;
}

.position-indicator {
	position: absolute;
	top: 0;
	height: 150px;
	pointer-events: none;
	transition: all 0.3s ease;
}

.indicator-info {
	position: absolute;
	top: -60px;
	left: 50%;
	transform: translateX(-50%);
	padding: 8rpx 16rpx;
	border-radius: 8rpx;
	display: flex;
	flex-direction: column;
	align-items: center;
	box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

.indicator-info .time_text {
	font-size: 24rpx;
	color: #ffffff;
	font-weight: bold;
}

.indicator-info .state_text {
	font-size: 20rpx;
	color: #ffffff;
	margin-top: 4rpx;
}

.chart-container {
	position: relative;
	width: 100%;
	height: 150px;
	cursor: pointer;
}
</style>
