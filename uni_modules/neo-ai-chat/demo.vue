<template>
	<view class="demo-container">
		<!-- 
			neo-ai-chat 组件演示 
			
			1. 默认 Mock 模式：
			<neo-ai-chat :use-mock="true" />
			
			2. 真实 API 模式 (DeepSeek)：
			<neo-ai-chat 
				api-key="sk-xxxxxxxx" 
				model="deepseek-chat"
			/>
			
			3. 真实 API 模式 (腾讯混元)：
			<neo-ai-chat 
				api-key="sk-xxxxxxxx" 
				base-url="https://api.hunyuan.cloud.tencent.com/v1/chat/completions"
				model="hunyuan-turbos-latest"
			/>
		-->
		
		<!-- 这里演示 Mock 模式，方便直接预览 -->
		<neo-ai-chat :use-mock="true" />
		
	</view>
</template>

<script>
	export default {
		data() {
			return {
				
			}
		},
		methods: {
			
		}
	}
</script>

<style lang="scss" scoped>
.demo-container {
	height: 100vh;
	background-color: #fff;
}
</style>
