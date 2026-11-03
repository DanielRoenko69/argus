#!groovy

pipeline {
    agent { label 'docker' }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
    }

    parameters {
        booleanParam(name: 'PUSH_IMAGES', defaultValue: false, description: 'Push verified images to a configured OCI registry.')
        string(name: 'REGISTRY_PREFIX', defaultValue: '', description: 'Optional registry/namespace, for example ghcr.io/acme.')
        string(name: 'REGISTRY_CREDENTIALS_ID', defaultValue: '', description: 'Jenkins username/password credential used only when PUSH_IMAGES is enabled.')
    }

    environment {
        CORE_IMAGE = 'argus-core'
        WORKSPACE_IMAGE = 'argus-agent-workspace'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.IMAGE_TAG = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
                }
            }
        }

        stage('Backend quality') {
            steps {
                sh 'npm ci'
                sh 'npm run certify:aiops-governance'
                sh 'npm run test:scripts'
                sh 'npm run test:sharded'
            }
        }

        stage('Console quality') {
            steps {
                dir('argus-console') {
                    sh 'npm ci'
                    sh 'npm run build'
                    sh 'npm test -- --run'
                }
            }
        }

        stage('Build verified images') {
            steps {
                sh 'docker build --pull --tag ${CORE_IMAGE}:${IMAGE_TAG} --file Dockerfile .'
                sh 'docker build --pull --tag ${WORKSPACE_IMAGE}:${IMAGE_TAG} --file agent-workspace/Dockerfile agent-workspace'
            }
        }

        stage('Push verified images') {
            when { expression { return params.PUSH_IMAGES } }
            steps {
                script {
                    if (!params.REGISTRY_PREFIX?.trim() || !params.REGISTRY_CREDENTIALS_ID?.trim()) {
                        error('REGISTRY_PREFIX and REGISTRY_CREDENTIALS_ID are required when PUSH_IMAGES is enabled.')
                    }
                }
                withCredentials([usernamePassword(
                    credentialsId: params.REGISTRY_CREDENTIALS_ID,
                    usernameVariable: 'REGISTRY_USERNAME',
                    passwordVariable: 'REGISTRY_PASSWORD'
                )]) {
                    sh '''
                        set +x
                        echo "$REGISTRY_PASSWORD" | docker login "${REGISTRY_PREFIX%%/*}" --username "$REGISTRY_USERNAME" --password-stdin
                        docker tag "${CORE_IMAGE}:${IMAGE_TAG}" "${REGISTRY_PREFIX}/${CORE_IMAGE}:${IMAGE_TAG}"
                        docker tag "${WORKSPACE_IMAGE}:${IMAGE_TAG}" "${REGISTRY_PREFIX}/${WORKSPACE_IMAGE}:${IMAGE_TAG}"
                        docker push "${REGISTRY_PREFIX}/${CORE_IMAGE}:${IMAGE_TAG}"
                        docker push "${REGISTRY_PREFIX}/${WORKSPACE_IMAGE}:${IMAGE_TAG}"
                    '''
                }
            }
        }
    }

    post {
        always {
            deleteDir()
        }
    }
}
