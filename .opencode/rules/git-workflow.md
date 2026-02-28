---
name: git-workflow
description: Git 커밋 및 PR 프로세스 규칙
alwaysApply: true
---

# Git 워크플로우

Git 커밋 및 PR 프로세스 규칙입니다.

## 커밋 메시지 형식

코드 리뷰의 용이성을 위해 모든 커밋의 수정 사항은 300줄 이하로 유지되어야 합니다.

```
<타입>(<스코프>): <설명>

<선택적 본문>
```

- 본문은 수정 사항에 대한 추가 설명만 작성합니다.
- 본문에 작성자를 포함하지 않습니다.
- 커밋 메시지는 현재 시제를 사용합니다. 예: `Added feature` 대신 `Add feature`.

### 예시 (간단 버전)

```
feat(nginx): 홈페이지에 방문자 카운터를 추가한다.

홈 서버 메인 페이지에 방문자 수를 보여주는 간단한 카운터를 추가한다.
```

### 예시 (상세 버전)

```
fix(docker): Plex 미디어 서버 컨테이너 재시작 문제를 해결한다.

Plex 미디어 서버 도커 컨테이너가 자동으로 재시작되지 않는 문제를 수정한다.

- docker-compose.yml 파일의 restart 정책을 `always`로 변경한다.
```

### 타입

| 타입     | 설명                                       |
| -------- | ------------------------------------------ |
| feat     | 새로운 기능 추가                           |
| fix      | 버그 수정                                  |
| docs     | 문서 수정                                  |
| style    | 코드 포맷팅, 세미콜론 누락, 코드 변경 없음 |
| refactor | 코드 리팩토링                              |
| test     | 테스트 코드, 리팩토링 테스트 코드 추가     |
| chore    | 빌드 업무 수정, 패키지 매니저 수정         |

예시:

```
feat(nginx): 리버스 프록시 설정을 구현한다.

- Nginx 설정 파일에 리버스 프록시 규칙을 추가한다.
- SSL 인증서를 적용하고 HTTPS 리다이렉션을 설정한다.
- 로드 밸런싱을 위한 업스트림 서버를 구성한다.

Resolves: #45
```

### 스코프

| 스코프    | 설명   | 예시                     |
| --------- | ------ | ------------------------ |
| users     | 사용자 | users: 사용자 인증 추가  |
| auth      | 인증   | auth: 사용자 인증 추가   |
| courses   | 코스   | courses: 코스 추가       |
| runs      | 러닝   | runs: 러닝 추가          |
| reviews   | 리뷰   | reviews: 리뷰 추가       |
| coupons   | 쿠폰   | coupons: 쿠폰 추가       |
| ads       | 광고   | ads: 광고 추가           |
| marketing | 마케팅 | marketing: 마케팅 추가   |
| db        | DB     | db: 사용자 인증 추가     |
| config    | config | config: 사용자 인증 추가 |

## Pull Request 워크플로우

PR 생성 시:

1. 전체 커밋 히스토리 분석
2. git diff로 모든 변경사항 확인
3. 포괄적인 PR 요약 작성
4. TODO가 포함된 테스트 계획 포함
5. 새 브랜치인 경우 -u 플래그로 푸시
6. PR template 사용: .github/pull_request_template.md

## 브랜치 전략

```
main
├── develop
├── feat/*
└── hotfix/*
```

### 허용 브랜치 이름

- `main`
- `develop`
- `feat/*`
- `hotfix/*`

### 브랜치 운용 규칙

1. 일반 개발 작업은 반드시 `feat/*` 브랜치에서 진행합니다.
2. `feat/*` 브랜치는 `develop`으로 머지합니다.
3. 긴급 수정은 반드시 `main`에서 `hotfix/*`로 분기합니다.
4. `hotfix/*` 브랜치는 `main`으로 머지합니다.
5. hotfix 완료 후에는 `main`과 `develop`을 반드시 동기화합니다.

## 머지 전 체크리스트

- [ ] 모든 테스트 통과
- [ ] 코드 리뷰 완료
- [ ] 보안 검사 통과
- [ ] 문서 업데이트 (필요시)
